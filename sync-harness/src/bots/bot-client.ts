// A synthetic room participant running the IDENTICAL shared sync core the
// browser runs (ClockEstimator + DriftController), against a SimPlayer
// instead of YouTube. Each bot lives on a virtual clock (offset + skew from
// the process clock) so the estimator is exercised with real inhomogeneity —
// and validated against the known injected offset.

import { io, type Socket } from 'socket.io-client';
import { ClockEstimator } from '../../../shared/sync-core/clock-estimator';
import {
  DriftController,
  type ControllerAction,
} from '../../../shared/sync-core/drift-controller';
import { DisciplineController } from '../../../shared/sync-core/discipline-controller';
import { isNewer, projectMediaTime } from '../../../shared/sync-core/timeline';
import type { ClockPong, ControlIntent, Timeline } from '../../../shared/sync-protocol';
import { SYNC_EVENTS } from '../../../shared/sync-protocol';
import { registerUser, type HarnessUser } from '../app-api.js';
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
  private socket!: Socket;
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
    this.socket = io(this.cfg.wsUrl, {
      transports: ['websocket'],
      auth: { token: this.user.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
    });
    this.socket.on(SYNC_EVENTS.timeline, (tl: Timeline) => {
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
    this.socket.on(SYNC_EVENTS.controlRejected, () => {
      this.rejected += 1;
    });
    this.socket.on('room-joined', (payload: { timeline?: Timeline }) => {
      if (payload.timeline && isNewer(payload.timeline, this.timeline)) {
        this.timeline = payload.timeline;
        this.seenSeqs.push(payload.timeline.seq);
      }
    });
    this.socket.on('error', (err: unknown) => {
      this.handlerErrors.push(JSON.stringify(err));
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bot ${this.cfg.index} connect timeout`)), 10_000);
      this.socket.on('connect', () => {
        clearTimeout(t);
        resolve();
      });
      this.socket.on('connect_error', (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
  }

  join(roomCode: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`bot ${this.cfg.index} join timeout`)), 10_000);
      this.socket.once('room-joined', () => {
        clearTimeout(t);
        resolve();
      });
      this.socket.emit('join-room', { roomCode, userId: this.user.id });
    });
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
    if (!this.socket.connected) return;
    const t0 = this.now();
    this.socket.emit(SYNC_EVENTS.clock, { t0 }, (pong: ClockPong) => {
      this.estimator.addSample({ ...pong, t3: this.now() });
    });
  }

  private execute(action: ControllerAction, tBot: number): void {
    switch (action.type) {
      case 'seek':
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
      case 'clear-rate':
        this.player.setRate(1);
        break;
      case 'none':
        break;
    }
  }

  sendIntent(roomCode: string, intent: ControlIntent, mediaTime: number): void {
    this.socket.emit(SYNC_EVENTS.control, { v: 1, roomCode, intent, mediaTime });
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
    this.socket.disconnect();
  }
}
