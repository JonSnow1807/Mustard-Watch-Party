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
  type PlayerLifecycle,
} from '../shared/sync-core/drift-controller';
import { isNewer, projectMediaTime } from '../shared/sync-core/timeline';
import { TelemetryRing } from './telemetry';
import type { PlayerAdapter } from '../shared/sync-core/player-adapter';

/**
 * What the engine needs from a player, beyond the shared PlayerAdapter
 * surface. Deliberately structural: the engine drives YouTube and a plain
 * <video> element through the same code path, which is what makes the sync
 * core player-agnostic rather than YouTube-shaped.
 */
export interface EngineAdapter extends PlayerAdapter {
  /** numeric player state for the harness telemetry contract */
  getRawState(): number;
  getDuration(): number;
  /** does this player honour fractional playback rates? (per video) */
  probeFractionalRate(): Promise<boolean>;
  dispose(): void;

  /**
   * Local audio. Optional on purpose, and deliberately NOT part of
   * PlayerAdapter in shared/sync-core: volume is a property of the room you
   * are physically sitting in, not of the shared timeline, so it must never
   * travel over the wire or influence the drift controller. A player that
   * cannot expose it simply omits these, and the UI hides the control.
   */
  setVolume?(fraction: number): void;
  setMuted?(muted: boolean): void;

  /**
   * Captions. Local like volume, and never synced: what language someone
   * reads in is a property of the person, not of the room.
   *
   * `hasCaptions` is what gates the UI. Every source answers it differently
   * and some cannot answer at all - YouTube's caption controls are
   * undocumented, and a plain MP4 usually carries no track - so the button
   * appears only when a player has SAID it has something to show. A control
   * that silently does nothing is worse than an absent one.
   */
  hasCaptions?(): boolean;
  setCaptionsEnabled?(enabled: boolean): void;
}

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
  /**
   * What the player itself is doing, for the UI only - the controller reads
   * the adapter directly and must not be routed through this snapshot. It is
   * here so a stalled room can say "buffering" instead of looking broken.
   */
  playerState: PlayerLifecycle;
}

const CLOCK_BURST_COUNT = 8;
const CLOCK_BURST_SPACING_MS = 150;
const CLOCK_STEADY_MS = 2000;
const CTRL_TICK_MS = 250;
/** room playing but the player refuses to start after this many play actions */
const GESTURE_CHIP_THRESHOLD = 3;

export class SyncEngine {
  private estimator = new ClockEstimator();
  // The predictive PI servo is the default: measured better than the
  // reactive controller in EVERY real-browser scenario (S0 16/49 vs 31/83,
  // S2 19/48 vs 25/139, S5 11/29 vs 60/97 - docs/measurements/servo).
  // ?controller=R selects the reactive arm, which remains the fallback
  // wherever the per-video fractional-rate probe fails.
  private controller: DriftController | DisciplineController =
    new URLSearchParams(window.location.search).get('controller') === 'R'
      ? new DriftController()
      : new DisciplineController();
  private telemetry = new TelemetryRing();
  private timeline: Timeline | null = null;
  private adapter: EngineAdapter | null = null;
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

  attachAdapter(adapter: EngineAdapter): void {
    this.adapter = adapter;
    void adapter.probeFractionalRate().then((ok) => {
      // a probe from an adapter that has since been replaced (video change,
      // reconnect) must not decide anything for the current one
      if (this.adapter !== adapter || this.disposed) return;
      this.fractionalRateOK = ok;
      if (!ok) this.fallBackToSeekFirst('probe failed');
    });
  }

  /**
   * The servo commands fractional playback rates; where the player snaps
   * them to 1 those commands do nothing and the error is never corrected.
   * README and SYNC_DESIGN both promise a SEEK-first fallback - this is it.
   * Swapping the instance (rather than gating inside the servo) keeps the
   * fallback on the reactive controller's OWN seek threshold; the servo's
   * inner controller runs a widened threshold so the servo can own that
   * band, which would leave 600ms of drift tolerated after a hand-off.
   */
  private fallBackToSeekFirst(reason: string): void {
    if (!(this.controller instanceof DisciplineController)) return;
    console.warn(`[sync] fractional rate unsupported (${reason}); using SEEK-first controller`);
    if (this.adapter) this.adapter.setRate(1);
    this.controller = new DriftController();
    // the replacement inherits the current stand-down state: `enabled` stays
    // true while a tab is hidden, so checking it alone would let a hidden
    // tab resume issuing playback actions through the new controller
    if (!this.enabled || document.hidden) this.controller.suspend();
  }

  /** Explicit user gesture: play/pause/scrub. Wait-for-broadcast — the
   * player is NOT touched here; everyone converges from sync:timeline. */
  sendIntent(intent: ControlIntent, mediaTime: number): void {
    // Send only on a live connection — NEVER buffer. socket.io would queue
    // this while disconnected and flush it after reconnect, delivering an
    // arbitrarily old command; the dedup TTL's soundness rests on a bounded
    // redelivery window (formal/SyncExactlyOnce.tla), and "no buffering" is
    // how the client enforces it. A dropped gesture is visible (nothing
    // happens, the user presses again — a NEW command with a NEW id).
    if (!this.socket.connected) return;
    this.socket.emit(SYNC_EVENTS.control, {
      v: 1,
      roomCode: this.roomCode,
      intent,
      mediaTime: Math.max(0, mediaTime),
      // idempotency key: the store applies each id at most once, so a
      // redelivered copy re-anchors the sender instead of re-committing
      cmdId: crypto.randomUUID(),
      // video fence: the videoId this client had applied when the gesture
      // happened. If a set-video lands first, the store refuses this
      // command instead of letting it move the new video, and answers
      // with the timeline the sender is missing
      // (formal/SyncSetVideo.tla). Absent before the first timeline:
      // unfenced, the legacy semantics.
      ...(this.timeline !== null ? { forVideoId: this.timeline.videoId } : {}),
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

  private execute(action: ControllerAction, adapter: EngineAdapter): void {
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
          // the probe lied for this video: the player snapped the rate
          this.fractionalRateOK = false;
          this.fallBackToSeekFirst('applied rate mismatch');
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
  private restoreRate(adapter: EngineAdapter): void {
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
      playerState: this.adapter?.getLifecycle() ?? 'unstarted',
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

/**
 * Change the room's video for everyone. A standalone function rather than
 * an engine method because its caller is the settings form, which lives
 * outside the player that owns the engine - but the protocol assembly and
 * the no-buffering rule stay in THIS file, next to sendIntent's.
 *
 * Wait-for-broadcast like every control: the local player switches when
 * sync:timeline says so. NOT fenced - switching is last-writer-wins by
 * design (formal/SyncSetVideo.tla). Returns false when disconnected: the
 * command is dropped, never buffered, and the caller should say so.
 */
export function sendSetVideo(
  socket: Socket,
  roomCode: string,
  videoUrl: string,
): boolean {
  if (!socket.connected) return false;
  socket.emit(SYNC_EVENTS.control, {
    v: 1,
    roomCode,
    intent: 'set-video',
    mediaTime: 0,
    videoUrl,
    cmdId: crypto.randomUUID(),
  });
  return true;
}
