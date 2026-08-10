// Wire protocol for the sync plane. Canonical copy lives in /shared;
// scripts/sync-shared.mjs mirrors it into both packages (see that script's
// header note). Every stateful payload carries v for future evolution —
// rolling compatibility itself is explicitly out of scope for v1.

/**
 * The room's playback state as a projectable function of server time,
 * never a frozen scalar.
 *
 *   mediaTimeAt(serverNow) = mediaTime + (isPlaying ? (serverNow - stampedAt)/1000 * rate : 0)
 *
 * Ordering: clients drop any timeline older than the last applied
 * (storeEpoch, seq). storeEpoch is minted from the STORE CLOCK DOMAIN at
 * rehydration and is therefore totally ordered - model-checked necessary
 * (formal/SyncTimeline.tla): random epochs let stale pre-flush broadcasts
 * regress clients, and no amount of client memory fixes it.
 */
export interface Timeline {
  v: 1;
  /** monotonic per storeEpoch; assigned atomically by the state store */
  seq: number;
  /** store-domain mint time (ms as string); numerically ordered */
  storeEpoch: string;
  videoId: string | null;
  isPlaying: boolean;
  /** media position (seconds) that was true at stampedAt */
  mediaTime: number;
  /** server-domain timestamp (ms) at which mediaTime was true */
  stampedAt: number;
  /** fixed at 1 in v1; field reserved so the protocol never changes shape */
  rate: 1;
  reason:
    | 'play'
    | 'pause'
    | 'seek'
    | 'set-video'
    | 'join'
    | 'snapshot'
    | 'succession';
  /** userId of the commander, when reason is a control intent */
  by?: string;
}

/** C→S via Socket.IO ack: client stamps t0, server replies immediately. */
export interface ClockPing {
  t0: number;
}

/** Server ack payload: t1 = receive, t2 = send (both server-domain ms). */
export interface ClockPong {
  t0: number;
  t1: number;
  t2: number;
}

export type ControlIntent = 'play' | 'pause' | 'seek' | 'set-video';

/**
 * C→S control. mediaTime is the position the commander intends:
 * play = start here, pause = freeze at the frame I saw (P4), seek = go here.
 * set-video ignores mediaTime (the new video always starts paused at 0).
 */
export interface SyncControl {
  v: 1;
  roomCode: string;
  intent: ControlIntent;
  mediaTime: number;
  /**
   * Client-minted idempotency key (UUID), the Stripe model: the store
   * applies each cmdId at most once and answers a duplicate with the
   * already-committed timeline instead of committing again. Optional for
   * wire compat - a command without one gets no dedup, exactly the old
   * behavior. Deduped atomically inside the same Lua script as the commit.
   */
  cmdId?: string;
  /**
   * set-video payload: the room's next videoUrl ('' clears it). Validated
   * at the gateway with the same shared admission rule as the REST DTOs.
   */
  videoUrl?: string;
  /**
   * Fence for position commands (play/pause/seek): the Timeline.videoId
   * the commander had applied when it minted this command. The store
   * refuses the command if the room's video has changed since - a seek
   * aimed at video A must never yank video B (formal/SyncSetVideo.tla,
   * the nofence config is the counterexample). Optional for wire compat:
   * a command without it is unfenced, exactly the old behavior. Not sent
   * on set-video - switching is last-writer-wins by design.
   */
  forVideoId?: string | null;
}

/** S→C error for rejected controls (permission, rate limit, no room). */
export interface SyncControlRejected {
  v: 1;
  roomCode: string;
  intent: ControlIntent;
  /**
   * stale-video: the command's forVideoId no longer matches the room -
   * refused, and a targeted sync:timeline re-anchor accompanies this
   * event, so clients treat it silently (the re-anchor IS the remedy).
   * invalid-video-url: a set-video whose URL failed the admission rule.
   */
  reason:
    | 'not-controller'
    | 'rate-limited'
    | 'room-not-found'
    | 'stale-video'
    | 'invalid-video-url';
}

/** S→room when the active controller changes (P3 succession). */
export interface RoomController {
  v: 1;
  roomCode: string;
  controllerId: string;
  reason: 'creator' | 'succession' | 'reclaim';
}

/**
 * S→room when the host ends the room.
 *
 * Deleting a room used to be silent to everyone in it: the row went, the
 * link stopped working, and the people watching sat in a room that no longer
 * existed until they happened to act. This is the goodbye.
 */
export interface RoomClosed {
  v: 1;
  roomCode: string;
}

/** C→S batched telemetry (off unless debug/harness enables it). */
export interface SyncReport {
  v: 1;
  roomCode: string;
  samples: Array<{
    tServerEst: number;
    playerTime: number;
    drift: number;
    offsetMs: number;
    uncertaintyMs: number;
    rttMs: number;
    ctrlState: string;
    seq: number;
  }>;
}

export const SYNC_EVENTS = {
  /** C→S with ack(ClockPong) */
  clock: 'sync:clock',
  /** C→S SyncControl */
  control: 'sync:control',
  /** S→room Timeline — the only state message */
  timeline: 'sync:timeline',
  /** S→C SyncControlRejected */
  controlRejected: 'sync:control-rejected',
  /** C→S SyncReport */
  report: 'sync:report',
  /** S→room RoomController */
  controller: 'room:controller',
  /** S→room RoomClosed */
  closed: 'room:closed',
} as const;
