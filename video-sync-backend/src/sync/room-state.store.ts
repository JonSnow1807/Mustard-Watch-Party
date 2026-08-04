import { Injectable } from '@nestjs/common';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import { applyControl, snapshot } from '../shared/sync-core/timeline';

/** Repair-sweep period. Each instance runs this timer for its local rooms. */
export const SWEEP_INTERVAL_MS = 10_000;
/**
 * Minimum gap between two committed sweeps for the SAME room, enforced inside
 * apply_snapshot.lua. Every instance holding a socket in a room fires its own
 * timer, so without this the room is swept once per instance per period. Set
 * just under the period so the next period always qualifies while duplicates
 * within a period never do.
 */
export const SWEEP_MIN_INTERVAL_MS = SWEEP_INTERVAL_MS - 1_000;

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
  | { kind: 'forwarded' }
  | { kind: 'missing' };

export interface RoomStateStore {
  get(roomCode: string): Promise<Timeline | null>;
  /** Restamp a control intent and commit it with the next seq. */
  applyControl(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    serverNow: number,
    by: string,
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
  ): Promise<ApplyOutcome> {
    const prev = this.rooms.get(roomCode);
    if (!prev) return Promise.resolve({ kind: 'missing' });
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
    this.rooms.delete(roomCode);
    return Promise.resolve();
  }
}
