import type { Socket } from 'socket.io-client';
import {
  ClockPong,
  ControlIntent,
  SYNC_EVENTS,
  Timeline,
} from '../shared/sync-protocol';
import { ClockEstimator } from '../shared/sync-core/clock-estimator';
import { DisciplineController } from '../shared/sync-core/discipline-controller';
import {
  DriftController,
  type ControllerAction,
} from '../shared/sync-core/drift-controller';
import { isNewer, projectMediaTime } from '../shared/sync-core/timeline';
import { TelemetryRing } from './telemetry';
import type { YouTubeAdapter } from './YouTubeAdapter';

export interface EngineStatus {
  timeline: Timeline | null;
  roomPlaying: boolean;
  /** projected room position at "now", seconds (UI progress bar) */
  projectedS: number;
  durationS: number;
  driftMs: number;
  offsetMs: number;
  uncertaintyMs: number;
  rttMs: number;
  ctrlState: string;
  seq: number;
  fractionalRateOK: boolean;
  /** autoplay/ad interference: playback needs a user gesture to proceed */
  needsGesture: boolean;
  seeksIssued: number;
}

const CLOCK_BURST_COUNT = 8;
const CLOCK_BURST_SPACING_MS = 150;
const CLOCK_STEADY_MS = 2000;
const CTRL_TICK_MS = 250;
/** room playing but the player refuses to start after this many play actions */
const GESTURE_CHIP_THRESHOLD = 3;

export class SyncEngine {
  private estimator = new ClockEstimator();
  // ?controller=P selects the predictive PI servo (A/B-measured: P50 drift
  // 7ms vs 81ms reactive on the bot fleet); reactive remains the default
  // until the real-browser A/B settles the question
  private controller: DriftController | DisciplineController =
    new URLSearchParams(window.location.search).get('controller') === 'P'
      ? new DisciplineController()
      : new DriftController();
  private telemetry = new TelemetryRing();
  private timeline: Timeline | null = null;
  private adapter: YouTubeAdapter | null = null;
  private fractionalRateOK = false;
  private enabled = true;
  private needsGesture = false;
  private playAttempts = 0;
  private clockTimer: ReturnType<typeof setInterval> | null = null;
  private ctrlTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(s: EngineStatus) => void>();
  private disposed = false;

  constructor(
    private socket: Socket,
    private roomCode: string,
  ) {}

  start(): void {
    this.telemetry.install();

    this.socket.on(SYNC_EVENTS.timeline, this.onTimeline);
    this.socket.on('room-joined', this.onRoomJoined);
    this.socket.on('connect', this.onReconnect);
    document.addEventListener('visibilitychange', this.onVisibility);

    this.burst(CLOCK_BURST_COUNT);
    this.clockTimer = setInterval(() => {
      if (!document.hidden) this.ping();
    }, CLOCK_STEADY_MS);

    this.ctrlTimer = setInterval(() => this.tick(), CTRL_TICK_MS);
  }

  attachAdapter(adapter: YouTubeAdapter): void {
    this.adapter = adapter;
    void adapter.probeFractionalRate().then((ok) => {
      this.fractionalRateOK = ok;
    });
  }

  /** Explicit user gesture: play/pause/scrub. Wait-for-broadcast — the
   * player is NOT touched here; everyone converges from sync:timeline. */
  sendIntent(intent: ControlIntent, mediaTime: number): void {
    this.socket.emit(SYNC_EVENTS.control, {
      v: 1,
      roomCode: this.roomCode,
      intent,
      mediaTime: Math.max(0, mediaTime),
    });
  }

  /** The needs-gesture chip was clicked: a real user activation exists. */
  resumeFromGesture(): void {
    this.needsGesture = false;
    this.playAttempts = 0;
    this.adapter?.play();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (enabled) {
      this.controller.resume();
    } else {
      this.controller.suspend();
      if (this.adapter) this.restoreRate(this.adapter);
    }
  }

  onStatus(listener: (s: EngineStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onTimeline = (tl: Timeline): void => {
    if (isNewer(tl, this.timeline)) this.timeline = tl;
  };

  private onRoomJoined = (payload: { timeline?: Timeline }): void => {
    if (payload.timeline && isNewer(payload.timeline, this.timeline)) {
      this.timeline = payload.timeline;
    }
  };

  private onReconnect = (): void => {
    // fresh path, fresh clock: drop history and re-burst; the page re-joins
    // the room and room-joined delivers a fresh timeline
    this.estimator.reset();
    this.burst(CLOCK_BURST_COUNT);
    // `enabled` is the single source of truth - a reconnect must never
    // silently re-enable sync the user switched off
    if (this.enabled) this.controller.resume();
  };

  private onVisibility = (): void => {
    if (document.hidden) {
      // throttled timers produce garbage clock samples; stand down
      this.controller.suspend();
      if (this.adapter) this.restoreRate(this.adapter);
    } else {
      this.burst(4);
      if (this.enabled) this.controller.resume();
    }
  };

  private burst(count: number): void {
    for (let i = 0; i < count; i++) {
      setTimeout(() => this.ping(), i * CLOCK_BURST_SPACING_MS);
    }
  }

  private ping(): void {
    if (this.disposed || !this.socket.connected) return;
    const t0 = Date.now();
    this.socket.emit(SYNC_EVENTS.clock, { t0 }, (pong: ClockPong) => {
      this.estimator.addSample({ ...pong, t3: Date.now() });
    });
  }

  private tick(): void {
    const tLocal = Date.now();
    this.estimator.tick(tLocal);
    const adapter = this.adapter;
    if (!adapter || !this.estimator.hasEstimate()) {
      this.emitStatus(tLocal);
      return;
    }

    const lifecycle = adapter.getLifecycle();
    const action = this.controller.evaluate({
      tLocal,
      serverNow: this.estimator.serverNow(tLocal),
      playerTime: adapter.getPlayerTime(),
      playerState: lifecycle,
      timeline: this.timeline,
      fractionalRateOK: this.fractionalRateOK,
    });
    this.execute(action, adapter);

    // autoplay/ad interference detector: the room is playing but repeated
    // play commands don't stick — stop fighting, ask for one gesture
    if (lifecycle === 'playing') {
      this.playAttempts = 0;
      this.needsGesture = false;
    }

    const est = this.estimator.getEstimate();
    const status = this.controller.getStatus();
    this.telemetry.push({
      tLocal,
      playerTime: adapter.getPlayerTime(),
      playerState: adapter.getRawState(),
      rtt: est.lastRttMs,
      driftMs: status.lastDriftS * 1000,
      offsetMs: est.offsetMs,
      uncertaintyMs: est.uncertaintyMs,
      ctrlState: status.state,
      seq: this.timeline?.seq ?? -1,
      fractionalRateOK: this.fractionalRateOK,
    });
    this.emitStatus(tLocal);
  }

  private execute(action: ControllerAction, adapter: YouTubeAdapter): void {
    switch (action.type) {
      case 'seek':
        // a seek implies rate 1: the controller drops its rate bookkeeping
        // when it seeks and cannot emit a second action, so the executor
        // owns the restore (otherwise the player keeps running at 0.95x)
        this.restoreRate(adapter);
        adapter.seekTo(action.toMediaTime);
        break;
      case 'play':
        this.playAttempts += 1;
        if (this.playAttempts > GESTURE_CHIP_THRESHOLD) {
          this.needsGesture = true;
        } else {
          adapter.play();
        }
        break;
      case 'pause':
        adapter.pause();
        break;
      case 'set-rate': {
        const applied = adapter.setRate(action.rate);
        if (this.controller instanceof DisciplineController) {
          this.controller.onRateApplied(applied);
        }
        if (Math.abs(applied - action.rate) > 0.001) {
          // the probe lied for this video; fall back to SEEK mode
          this.fractionalRateOK = false;
        }
        break;
      }
      case 'clear-rate':
        this.restoreRate(adapter);
        break;
      case 'none':
        break;
    }
  }

  /** Return the player to rate 1 and keep the controller's belief in sync. */
  private restoreRate(adapter: YouTubeAdapter): void {
    const applied = adapter.setRate(1);
    if (this.controller instanceof DisciplineController) {
      this.controller.onRateApplied(applied);
    }
  }

  private emitStatus(tLocal: number): void {
    if (this.listeners.size === 0) return;
    const est = this.estimator.getEstimate();
    const ctrl = this.controller.getStatus();
    const serverNow = this.estimator.serverNow(tLocal);
    const status: EngineStatus = {
      timeline: this.timeline,
      roomPlaying: this.timeline?.isPlaying ?? false,
      projectedS: this.timeline
        ? projectMediaTime(this.timeline, serverNow)
        : 0,
      durationS: this.adapter?.getDuration() ?? 0,
      driftMs: ctrl.lastDriftS * 1000,
      offsetMs: est.offsetMs,
      uncertaintyMs: est.uncertaintyMs,
      rttMs: est.lastRttMs,
      ctrlState: ctrl.state,
      seq: this.timeline?.seq ?? -1,
      fractionalRateOK: this.fractionalRateOK,
      needsGesture: this.needsGesture,
      seeksIssued: ctrl.seeksIssued,
    };
    this.listeners.forEach((l) => l(status));
  }

  dispose(): void {
    this.disposed = true;
    if (this.clockTimer) clearInterval(this.clockTimer);
    if (this.ctrlTimer) clearInterval(this.ctrlTimer);
    this.socket.off(SYNC_EVENTS.timeline, this.onTimeline);
    this.socket.off('room-joined', this.onRoomJoined);
    this.socket.off('connect', this.onReconnect);
    document.removeEventListener('visibilitychange', this.onVisibility);
    // NOT adapter.dispose(): the component owns the adapter's lifetime and
    // the engine can outlive/underlive it (socket reconnects vs video change)
    this.telemetry.uninstall();
    this.listeners.clear();
  }
}
