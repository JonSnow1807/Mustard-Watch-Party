import { Inject, Injectable, Optional } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ClockDomainService } from '../redis/clock-domain.service';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import { projectMediaTime } from '../shared/sync-core/timeline';
import { ROOM_STATE_STORE, RoomStateStore } from './room-state.store';

export type ControlResult =
  | { ok: true; timeline: Timeline }
  /** the actor plane forwarded this intent; the room's owner broadcasts it */
  | { ok: true; timeline: null; forwarded: true }
  | { ok: false; reason: 'not-controller' | 'rate-limited' | 'room-not-found' };

interface RoomMeta {
  creatorId: string;
  allowGuestControl: boolean;
  videoId: string | null;
  /** promoted controller while the creator is away (P3) */
  activeController: string | null;
}

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const BUCKET_CAPACITY = 10;
const BUCKET_REFILL_PER_S = 5;
const PERSIST_DEBOUNCE_MS = 10_000;

@Injectable()
export class TimelineService {
  private meta = new Map<string, RoomMeta>();
  private buckets = new Map<string, TokenBucket>();
  private persistTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(ROOM_STATE_STORE) private store: RoomStateStore,
    private database: DatabaseService,
    @Optional() private clock?: ClockDomainService,
  ) {}

  /**
   * Ensure the room has an authoritative timeline; called on join. Hydrates
   * from the Room row on first touch — always paused (P5).
   */
  /** serializes ensureRoom against releaseRoom for one room */
  private roomGate = new Map<string, Promise<unknown>>();

  private gated<T>(roomCode: string, op: () => Promise<T>): Promise<T> {
    const prior = this.roomGate.get(roomCode) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(op);
    this.roomGate.set(roomCode, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.roomGate.get(roomCode) === next)
          this.roomGate.delete(roomCode);
      });
    return next;
  }

  async ensureRoom(
    roomCode: string,
    room: {
      creatorId: string;
      allowGuestControl: boolean;
      videoUrl: string | null;
      currentTime: number;
    },
    now: number,
  ): Promise<Timeline> {
    // a release running concurrently would delete the meta/store state this
    // join is creating; both run on one per-room gate
    return this.gated(roomCode, () =>
      this.ensureRoomInner(roomCode, room, now),
    );
  }

  private async ensureRoomInner(
    roomCode: string,
    room: {
      creatorId: string;
      allowGuestControl: boolean;
      videoUrl: string | null;
      currentTime: number;
    },
    now: number,
  ): Promise<Timeline> {
    if (!this.meta.has(roomCode)) {
      this.meta.set(roomCode, {
        creatorId: room.creatorId,
        allowGuestControl: room.allowGuestControl,
        videoId: room.videoUrl,
        activeController: null,
      });
    }
    return this.store.init(roomCode, room.videoUrl, room.currentTime, now);
  }

  /** Projected timeline for a joiner (or null if the room was never touched). */
  async currentTimeline(roomCode: string): Promise<Timeline | null> {
    return this.store.get(roomCode);
  }

  private allowedToControl(meta: RoomMeta, userId: string): boolean {
    return (
      meta.allowGuestControl ||
      userId === meta.creatorId ||
      userId === meta.activeController
    );
  }

  private takeToken(socketId: string, now: number): boolean {
    const bucket = this.buckets.get(socketId) ?? {
      tokens: BUCKET_CAPACITY,
      lastRefill: now,
    };
    bucket.tokens = Math.min(
      BUCKET_CAPACITY,
      bucket.tokens + ((now - bucket.lastRefill) / 1000) * BUCKET_REFILL_PER_S,
    );
    bucket.lastRefill = now;
    if (bucket.tokens < 1) {
      this.buckets.set(socketId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(socketId, bucket);
    return true;
  }

  async handleControl(
    roomCode: string,
    socketId: string,
    userId: string,
    intent: ControlIntent,
    mediaTime: number,
    now: number,
  ): Promise<ControlResult> {
    const meta = this.meta.get(roomCode);
    if (!meta) return { ok: false, reason: 'room-not-found' };
    if (!this.allowedToControl(meta, userId)) {
      return { ok: false, reason: 'not-controller' };
    }
    if (!this.takeToken(socketId, now)) {
      return { ok: false, reason: 'rate-limited' };
    }
    const outcome = await this.store.applyControl(
      roomCode,
      intent,
      mediaTime,
      now,
      userId,
    );
    if (outcome.kind === 'missing')
      return { ok: false, reason: 'room-not-found' };
    if (outcome.kind === 'forwarded') {
      return { ok: true, timeline: null, forwarded: true };
    }
    this.schedulePersist(roomCode);
    return { ok: true, timeline: outcome.timeline };
  }

  /** Periodic re-anchor; null when the room has no state (nothing to sweep). */
  async sweepSnapshot(roomCode: string, now: number): Promise<Timeline | null> {
    const current = await this.store.get(roomCode);
    if (!current) return null;
    // paused rooms don't advance; re-broadcasting them is pure noise
    if (!current.isPlaying) return null;
    return this.store.applySnapshot(roomCode, now);
  }

  /**
   * P3 succession: the departing user stops controlling; promote the given
   * candidate (longest-connected participant) unless guests can control
   * anyway. Returns the new controller id when a change happened.
   */
  succession(
    roomCode: string,
    departedUserId: string,
    candidateUserId: string | null,
  ): { controllerId: string; reason: 'succession' } | null {
    const meta = this.meta.get(roomCode);
    if (!meta || meta.allowGuestControl) return null;
    const controls =
      departedUserId === meta.creatorId ||
      departedUserId === meta.activeController;
    if (!controls) return null;
    if (!candidateUserId || candidateUserId === departedUserId) return null;
    meta.activeController = candidateUserId;
    return { controllerId: candidateUserId, reason: 'succession' };
  }

  /** Creator returned: control reverts (P3). */
  reclaim(
    roomCode: string,
    userId: string,
  ): { controllerId: string; reason: 'reclaim' } | null {
    const meta = this.meta.get(roomCode);
    if (!meta) return null;
    if (userId === meta.creatorId && meta.activeController !== null) {
      meta.activeController = null;
      return { controllerId: userId, reason: 'reclaim' };
    }
    return null;
  }

  /**
   * Tear down an empty room. Ordering matters: the in-memory maps are dropped
   * FIRST (synchronously, so no join can interleave), and only then is the
   * slow persistence flush awaited. Deleting after the await let a join that
   * landed mid-flush have its freshly created state destroyed.
   */
  releaseRoom(roomCode: string): Promise<void> {
    return this.gated(roomCode, () => this.releaseRoomInner(roomCode));
  }

  private async releaseRoomInner(roomCode: string): Promise<void> {
    const timeline = await this.store.get(roomCode);
    this.meta.delete(roomCode);
    await this.store.clear(roomCode);
    if (timeline) await this.persistTimeline(roomCode, timeline);
  }

  dropSocket(socketId: string): void {
    this.buckets.delete(socketId);
  }

  private schedulePersist(roomCode: string): void {
    if (this.persistTimers.has(roomCode)) return;
    const timer = setTimeout(() => {
      this.persistTimers.delete(roomCode);
      void this.flushPersist(roomCode);
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimers.set(roomCode, timer);
  }

  private async flushPersist(roomCode: string): Promise<void> {
    const timer = this.persistTimers.get(roomCode);
    if (timer) {
      clearTimeout(timer);
      this.persistTimers.delete(roomCode);
    }
    const tl = await this.store.get(roomCode);
    if (!tl) return;
    await this.persistTimeline(roomCode, tl);
  }

  private async persistTimeline(roomCode: string, tl: Timeline): Promise<void> {
    const now = this.clock ? this.clock.now() : Date.now();
    try {
      await this.database.room.update({
        where: { code: roomCode },
        data: {
          currentTime: projectMediaTime(tl, now),
          isPlaying: tl.isPlaying,
          lastSyncAt: new Date(now),
        },
      });
    } catch (error) {
      console.error(`timeline persist failed for ${roomCode}:`, error);
    }
  }
}
