// A synthetic room participant running the IDENTICAL shared sync core the
// browser runs (ClockEstimator + DriftController), against a SimPlayer
// instead of YouTube. Each bot lives on a virtual clock (offset + skew from
// the process clock) so the estimator is exercised with real inhomogeneity —
// and validated against the known injected offset.

import { ClockEstimator } from '../../../shared/sync-core/clock-estimator';
import {
  DriftController,
  type ControllerAction,
} from '../../../shared/sync-core/drift-controller';
import { DisciplineController } from '../../../shared/sync-core/discipline-controller';
import { isNewer, projectMediaTime } from '../../../shared/sync-core/timeline';
import type { ClockPong, ControlIntent, Timeline } from '../../../shared/sync-protocol';
import { registerUser, type HarnessUser } from '../app-api.js';
import {
  RawWSBinaryTransport,
  SocketIOTransport,
  type SyncTransport,
} from './transport.js';
import { SimPlayer, mulberry32, type SimPlayerConfig } from './sim-player.js';

export interface BotConfig {
  index: number;
  runId: string;
  wsUrl: string;
  roomCode?: string;
  /** virtual clock: botNow = realNow + clockOffsetMs + clockSkew*(elapsed) */
  clockOffsetMs: number;
  clockSkew: number;
  player: Partial<SimPlayerConfig>;
  seed: number;
  /** reactive (threshold state machine) or predictive (PI servo) */
  controller?: 'reactive' | 'predictive';
  /** node (Socket.IO/JSON) or relay (raw-WS binary, relay-go) */
  plane?: 'node' | 'relay';
}

export interface BotSample {
  bot: number;
  tReal: number;
  /** vs-timeline drift, seconds (the protocol-level sync error) */
  driftS: number | null;
  /** estimator error vs injected offset, ms (validation) */
  thetaErrorMs: number | null;
  seq: number;
  lifecycle: string;
  ctrlState: string;
  seeks: number;
}

export interface BotReport {
  bot: number;
  samples: BotSample[];
  seqGaps: number[];
  handlerErrors: string[];
  rejected: number;
}

export class BotClient {
  private transport!: SyncTransport;
  private estimator = new ClockEstimator();
  private controller: DriftController | DisciplineController;
  private player: SimPlayer;
  private timeline: Timeline | null = null;
  private rng: () => number;
  private epoch = Date.now();
  private samples: BotSample[] = [];
  private seenSeqs: number[] = [];
  private handlerErrors: string[] = [];
  private rejected = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  user!: HarnessUser;

  constructor(private cfg: BotConfig) {
    this.controller =
      cfg.controller === 'predictive'
        ? new DisciplineController()
        : new DriftController();
    this.rng = mulberry32(cfg.seed);
    this.player = new SimPlayer({
      playbackSkew: 0,
      commandLatencyMinMs: 80,
      commandLatencyMaxMs: 300,
      seekSettleMinMs: 150,
      seekSettleMaxMs: 600,
      fractionalRateOK: false,
      rng: this.rng,
      ...cfg.player,
    });
  }

  /** the bot's own (virtual) clock */
  private now(): number {
    const real = Date.now();
    return real + this.cfg.clockOffsetMs + this.cfg.clockSkew * (real - this.epoch);
  }

  async connect(): Promise<void> {
    this.user = await registerUser(this.cfg.runId, this.cfg.index);
    this.transport =
      this.cfg.plane === 'relay'
        ? new RawWSBinaryTransport(this.cfg.wsUrl)
        : new SocketIOTransport(this.cfg.wsUrl);
    this.transport.onTimeline((tl: Timeline) => {
      if (isNewer(tl, this.timeline)) {
        if (
          this.timeline &&
          tl.storeEpoch === this.timeline.storeEpoch &&
          tl.seq > this.timeline.seq + 1
        ) {
          for (let missing = this.timeline.seq + 1; missing < tl.seq; missing++) {
            // gaps are repaired by the sweep, but we count them honestly
            this.seenSeqs.push(-missing);
          }
        }
        this.timeline = tl;
        this.seenSeqs.push(tl.seq);
      }
    });
    this.transport.onRejected(() => {
      this.rejected += 1;
    });
    this.transport.onError((err) => {
      this.handlerErrors.push(err);
    });
    await this.transport.connect(this.user.token ?? '');
  }

  async join(roomCode: string): Promise<void> {
    const tl = await this.transport.join(roomCode, this.user.id);
    if (tl && isNewer(tl, this.timeline)) {
      this.timeline = tl;
      this.seenSeqs.push(tl.seq);
    }
  }

  start(): void {
    // clock burst then steady, on the virtual clock
    for (let i = 0; i < 8; i++) setTimeout(() => this.ping(), i * 150);
    this.timers.push(setInterval(() => this.ping(), 2000));

    this.timers.push(
      setInterval(() => {
        const tBot = this.now();
        this.estimator.tick(tBot);
        this.player.advance(tBot);
        if (!this.estimator.hasEstimate()) return;
        const serverNow = this.estimator.serverNow(tBot);
        const action = this.controller.evaluate({
          tLocal: tBot,
          serverNow,
          playerTime: this.player.getPlayerTime(),
          playerState: this.player.getLifecycle(),
          timeline: this.timeline,
          fractionalRateOK: this.cfg.controller !== undefined,
        });
        this.execute(action, tBot);

        const drift =
          this.timeline && this.timeline.isPlaying && this.player.getLifecycle() === 'playing'
            ? this.player.getPlayerTime() - projectMediaTime(this.timeline, serverNow)
            : null;
        // the injected ground truth: serverNow(real clock) vs bot clock
        const trueOffset = Date.now() - tBot;
        const thetaError = this.estimator.hasEstimate()
          ? this.estimator.getEstimate().offsetMs - trueOffset
          : null;
        const ctrl = this.controller.getStatus();
        this.samples.push({
          bot: this.cfg.index,
          tReal: Date.now(),
          driftS: drift,
          thetaErrorMs: thetaError,
          seq: this.timeline?.seq ?? -1,
          lifecycle: this.player.getLifecycle(),
          ctrlState: ctrl.state,
          seeks: ctrl.seeksIssued,
        });
      }, 250),
    );
  }

  private ping(): void {
    if (!this.transport.connected()) return;
    const t0 = this.now();
    this.transport.sendClock(t0, (pong: ClockPong) => {
      this.estimator.addSample({ ...pong, t3: this.now() });
    });
  }

  private execute(action: ControllerAction, tBot: number): void {
    switch (action.type) {
      case 'seek':
        // same executor contract as the browser engine: a seek restores rate 1
        this.player.setRate(1);
        if (this.controller instanceof DisciplineController) {
          this.controller.onRateApplied(1);
        }
        this.player.seekTo(tBot, action.toMediaTime);
        break;
      case 'play':
        this.player.play(tBot);
        break;
      case 'pause':
        this.player.pause(tBot);
        break;
      case 'set-rate': {
        const applied = this.player.setRate(action.rate);
        if (this.controller instanceof DisciplineController) {
          this.controller.onRateApplied(applied);
        }
        break;
      }
      case 'clear-rate': {
        const applied = this.player.setRate(1);
        if (this.controller instanceof DisciplineController) {
          this.controller.onRateApplied(applied);
        }
        break;
      }
      case 'none':
        break;
    }
  }

  sendIntent(roomCode: string, intent: ControlIntent, mediaTime: number): void {
    this.transport.sendControl(roomCode, intent, mediaTime);
  }

  scriptedStall(durationMs: number): void {
    this.player.stall(this.now(), durationMs);
  }

  report(): BotReport {
    const gaps = this.seenSeqs.filter((x) => x < 0).map((x) => -x);
    return {
      bot: this.cfg.index,
      samples: this.samples,
      seqGaps: gaps,
      handlerErrors: this.handlerErrors,
      rejected: this.rejected,
    };
  }

  dispose(): void {
    this.timers.forEach((t) => clearInterval(t));
    this.transport.disconnect();
  }
}
