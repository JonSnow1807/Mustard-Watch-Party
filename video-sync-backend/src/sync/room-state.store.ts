import { Injectable } from '@nestjs/common';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import { applyControl, snapshot } from '../shared/sync-core/timeline';

/** Repair-sweep period. Each instance runs this timer for its local rooms. */
export const SWEEP_INTERVAL_MS = 10_000;
/**
 * The period apply_snapshot.lua buckets time into when deduping sweeps. Every
 * instance holding a socket in a room fires its own timer, so without the
 * guard the room is swept once per instance per period. The script commits at
 * most once per aligned window of this length.
 */
export const SWEEP_DEDUP_PERIOD_MS = SWEEP_INTERVAL_MS;

/**
 * The authority seam for room playback state. The engine only speaks this
 * interface; M6 swaps in a Redis/Lua implementation for multi-instance
 * correctness without touching engine logic. apply() must assign seq
 * atomically with the state write.
 */
/**
 * Outcome of a control application. The third case exists for the actor
 * plane: when another instance owns the room, this instance forwards the
 * intent and that owner broadcasts - so the caller must NOT broadcast.
 */
export type ApplyOutcome =
  | { kind: 'committed'; timeline: Timeline }
  /**
   * The command's cmdId was already applied: the store did NOT commit
   * again, and `timeline` is the current committed state - answer the
   * caller with it (their targeted re-anchor), but do not broadcast: the
   * original commit already did.
   */
  | { kind: 'duplicate'; timeline: Timeline }
  | { kind: 'forwarded' }
  | { kind: 'missing' };

/**
 * How long the store remembers an applied cmdId. This is a CORRECTNESS
 * parameter, not a tuning knob (formal/SyncExactlyOnce.tla, the earlyevict
 * config): it must exceed the client's maximum redelivery window. The
 * client enforces that window by only ever sending a control on a live
 * connection - no send-buffering, so nothing can flush an old command
 * after a long reconnect - which leaves the residual redelivery sources
 * as ioredis resending an EVAL whose reply was lost (seconds) and the
 * actor plane's forward publish being redelivered (seconds). Fifteen
 * minutes is orders of magnitude above both.
 */
export const CMD_DEDUP_TTL_MS = 15 * 60_000;

export interface RoomStateStore {
  get(roomCode: string): Promise<Timeline | null>;
  /**
   * Restamp a control intent and commit it with the next seq. `cmdId`, when
   * present, is checked-and-recorded ATOMICALLY with the commit: a repeat of
   * an applied id returns `duplicate` with the current state instead of
   * committing again.
   */
  applyControl(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    serverNow: number,
    by: string,
    cmdId?: string,
  ): Promise<ApplyOutcome>;
  /** Re-anchor the projection (periodic sweep); returns the committed state. */
  applySnapshot(roomCode: string, serverNow: number): Promise<Timeline | null>;
  /**
   * First-writer-wins rehydration from persistence. Always restored paused
   * (P5): a stale epoch must not fast-forward a room that was "playing"
   * days ago.
   */
  init(
    roomCode: string,
    videoId: string | null,
    mediaTime: number,
    serverNow: number,
  ): Promise<Timeline>;
  clear(roomCode: string): Promise<void>;
}

export const ROOM_STATE_STORE = Symbol('ROOM_STATE_STORE');

@Injectable()
export class InMemoryRoomStateStore implements RoomStateStore {
  private rooms = new Map<string, Timeline>();
  /** roomCode -> cmdId -> expiry; mirrors the Redis SET NX PX semantics so
   *  CI without Redis exercises the same dedup contract. */
  private cmdSeen = new Map<string, Map<string, number>>();

  // Single-process: JS execution is the serializer, so plain sync mutation
  // inside async methods is atomic per call.
  get(roomCode: string): Promise<Timeline | null> {
    return Promise.resolve(this.rooms.get(roomCode) ?? null);
  }

  applyControl(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    serverNow: number,
    by: string,
    cmdId?: string,
  ): Promise<ApplyOutcome> {
    const prev = this.rooms.get(roomCode);
    if (!prev) return Promise.resolve({ kind: 'missing' });
    if (cmdId) {
      const seen = this.cmdSeen.get(roomCode) ?? new Map<string, number>();
      // lazy expiry, same effect as PX: an expired record is no record
      for (const [id, expiresAt] of seen) {
        if (expiresAt <= serverNow) seen.delete(id);
      }
      if (seen.has(cmdId)) {
        this.cmdSeen.set(roomCode, seen);
        return Promise.resolve({ kind: 'duplicate', timeline: prev });
      }
      seen.set(cmdId, serverNow + CMD_DEDUP_TTL_MS);
      this.cmdSeen.set(roomCode, seen);
    }
    const next: Timeline = {
      ...applyControl(prev, intent, mediaTime, serverNow, by),
      seq: prev.seq + 1,
    };
    this.rooms.set(roomCode, next);
    return Promise.resolve({ kind: 'committed', timeline: next });
  }

  applySnapshot(roomCode: string, serverNow: number): Promise<Timeline | null> {
    const prev = this.rooms.get(roomCode);
    if (!prev) return Promise.resolve(null);
    const next: Timeline = { ...snapshot(prev, serverNow), seq: prev.seq + 1 };
    this.rooms.set(roomCode, next);
    return Promise.resolve(next);
  }

  init(
    roomCode: string,
    videoId: string | null,
    mediaTime: number,
    serverNow: number,
  ): Promise<Timeline> {
    const existing = this.rooms.get(roomCode);
    if (existing) return Promise.resolve(existing);
    const created: Timeline = {
      v: 1,
      seq: 0,
      // ordered epoch (store-domain mint time): the TLA+ spec proved random
      // epochs unsound - a stale pre-flush broadcast can regress clients
      storeEpoch: String(serverNow),
      videoId,
      isPlaying: false,
      mediaTime,
      stampedAt: serverNow,
      rate: 1,
      reason: 'join',
    };
    this.rooms.set(roomCode, created);
    return Promise.resolve(created);
  }

  clear(roomCode: string): Promise<void> {
    this.cmdSeen.delete(roomCode);
    this.rooms.delete(roomCode);
    return Promise.resolve();
  }
}
