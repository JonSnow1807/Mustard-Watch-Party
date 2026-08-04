import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  Logger,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type Redis from 'ioredis';
import { REDIS_KV, REDIS_PUB, REDIS_SUB } from '../redis/redis.module';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import { applyControl, snapshot } from '../shared/sync-core/timeline';
import { ApplyOutcome, RoomStateStore } from './room-state.store';

/**
 * Coordination plane B: single-owner room actors with lease fencing.
 *
 * Exactly the design verified in `formal/SyncActor.tla` before a line of this
 * file existed. One instance owns a room at a time under a lease; the owner
 * holds the timeline in memory and serializes control events locally, then
 * commits under its FENCE (the lease epoch). A commit from an instance that
 * lost the lease - a revived zombie - is rejected by the Lua guard, which is
 * the property the spec checks (NoStaleFenceWrite).
 *
 * Non-owners do not touch state: they forward the intent to the owner over
 * pub/sub and let the owner commit and broadcast. Broadcast happens only
 * AFTER an accepted commit, matching the spec's Commit action - a faster
 * broadcast-then-commit would be a design the spec does not cover.
 *
 * Epochs do double duty: the zombie fence here IS the client ordering rule
 * from `SyncTimeline.tla`, so plane B needs no new client-side concept.
 */

const LEASE_TTL_MS = 10_000;
const RENEW_MS = 3_000;
const KEY_TTL_MS = 24 * 60 * 60 * 1000;

interface Lease {
  owner: string;
  epoch: string;
  mine: boolean;
}

interface RedisWithActor extends Redis {
  actorClaim(
    leaseKey: string,
    instanceId: string,
    ttlMs: string,
  ): Promise<string>;
  actorReclaim(
    leaseKey: string,
    observedOwner: string,
    observedFence: string,
  ): Promise<number>;
  actorInit(
    leaseKey: string,
    timelineKey: string,
    instanceId: string,
    fence: string,
    mediaTime: string,
    videoId: string,
    ttlMs: string,
  ): Promise<string | null>;
  actorCommit(
    leaseKey: string,
    timelineKey: string,
    instanceId: string,
    fence: string,
    isPlaying: string,
    mediaTime: string,
    reason: string,
    by: string,
    videoId: string,
    ttlMs: string,
  ): Promise<string | null>;
}

export interface ForwardedControl {
  roomCode: string;
  intent: ControlIntent;
  mediaTime: number;
  by: string;
}

@Injectable()
export class ActorRoomStateStore
  implements RoomStateStore, OnApplicationShutdown
{
  private readonly logger = new Logger(ActorRoomStateStore.name);
  readonly instanceId = process.env.INSTANCE_ID ?? hostname();

  /** rooms this instance currently owns: the actor's in-memory authority */
  private owned = new Map<string, { fence: string; timeline: Timeline }>();
  /**
   * Per-room serialization queue. The class doc claims the owner serializes
   * control events locally; without this it did not: two concurrent calls
   * both read entry.timeline before either commit replaced it, so a play or
   * pause projected its position from stale state (a seek is immune - it
   * carries an absolute mediaTime). A promise chain restores the invariant
   * with no distributed lock.
   */
  private queues = new Map<string, Promise<unknown>>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private onForwarded: ((c: ForwardedControl) => void | Promise<void>) | null =
    null;

  private kv: RedisWithActor;

  constructor(
    @Inject(REDIS_KV) kv: Redis,
    @Inject(REDIS_PUB) private pub: Redis,
    @Inject(REDIS_SUB) private sub: Redis,
  ) {
    const dir = join(__dirname, 'lua');
    const read = (f: string): string => readFileSync(join(dir, f), 'utf8');
    kv.defineCommand('actorClaim', {
      numberOfKeys: 1,
      lua: read('actor_claim.lua'),
    });
    kv.defineCommand('actorReclaim', {
      numberOfKeys: 1,
      lua: read('actor_reclaim.lua'),
    });
    kv.defineCommand('actorInit', {
      numberOfKeys: 2,
      lua: read('actor_init.lua'),
    });
    kv.defineCommand('actorCommit', {
      numberOfKeys: 2,
      lua: read('actor_commit.lua'),
    });
    this.kv = kv as RedisWithActor;

    this.sub.subscribe(this.forwardChannel(this.instanceId)).catch((e) => {
      this.logger.error({ err: String(e) }, 'actor: forward subscribe failed');
    });
    this.sub.on('message', (channel, payload) => {
      if (channel !== this.forwardChannel(this.instanceId)) return;
      try {
        // `void promise` does NOT handle a rejection: an async forward
        // handler that throws would become an unhandled rejection, which
        // terminates the process under Node's default mode. A forwarded
        // control failing must degrade that one control, not the instance.
        const result = this.onForwarded?.(
          JSON.parse(payload) as ForwardedControl,
        );
        if (result instanceof Promise) {
          void result.catch((e) =>
            this.logger.error(
              { err: String(e) },
              'actor: forward handler failed',
            ),
          );
        }
      } catch (e) {
        this.logger.error({ err: String(e) }, 'actor: bad forwarded payload');
      }
    });

    // Renew held leases well inside the TTL. Missing a renewal is safe: the
    // lease simply expires and another instance claims with a higher fence,
    // which fences this one out on its next commit.
    this.renewTimer = setInterval(() => {
      void this.renewAll().catch((e) =>
        this.logger.error({ err: String(e) }, 'actor: renew sweep failed'),
      );
    }, RENEW_MS);
  }

  /** The gateway registers how a forwarded intent is executed + broadcast. */
  setForwardHandler(cb: (c: ForwardedControl) => void | Promise<void>): void {
    this.onForwarded = cb;
  }

  private leaseKey(roomCode: string): string {
    return `room:${roomCode}:lease`;
  }
  private timelineKey(roomCode: string): string {
    return `room:${roomCode}:tl`;
  }
  private forwardChannel(instanceId: string): string {
    return `actor:fwd:${instanceId}`;
  }

  private async claim(roomCode: string): Promise<Lease> {
    const raw = await this.kv.actorClaim(
      this.leaseKey(roomCode),
      this.instanceId,
      String(LEASE_TTL_MS),
    );
    return JSON.parse(raw) as Lease;
  }

  private async renewAll(): Promise<void> {
    for (const roomCode of [...this.owned.keys()]) {
      try {
        const lease = await this.claim(roomCode);
        if (!lease.mine) {
          // lost the lease (a pause long enough to expire it): drop the
          // in-memory authority rather than commit as a zombie
          this.owned.delete(roomCode);
          this.logger.warn(
            { roomCode, owner: lease.owner },
            'actor: lease lost',
          );
        }
      } catch (e) {
        this.logger.error({ err: String(e), roomCode }, 'actor: renew failed');
      }
    }
  }

  async get(roomCode: string): Promise<Timeline | null> {
    const local = this.owned.get(roomCode);
    if (local) return local.timeline; // in-memory authority: no round trip
    const h = await this.kv.hgetall(this.timelineKey(roomCode));
    if (!h || Object.keys(h).length === 0) return null;
    return this.fromHash(h);
  }

  private fromHash(h: Record<string, string>): Timeline {
    return {
      v: 1,
      seq: Number(h.seq),
      storeEpoch: h.storeEpoch,
      videoId: h.videoId === '' ? null : h.videoId,
      isPlaying: h.isPlaying === '1',
      mediaTime: Number(h.mediaTime),
      stampedAt: Number(h.stampedAt),
      rate: 1,
      reason: h.reason as Timeline['reason'],
      by: h.by === '' ? undefined : h.by,
    };
  }

  private async commit(
    roomCode: string,
    fence: string,
    next: Omit<Timeline, 'seq'>,
  ): Promise<Timeline | null> {
    const raw = await this.kv.actorCommit(
      this.leaseKey(roomCode),
      this.timelineKey(roomCode),
      this.instanceId,
      fence,
      next.isPlaying ? '1' : '0',
      String(next.mediaTime),
      next.reason,
      next.by ?? '',
      next.videoId ?? '',
      String(KEY_TTL_MS),
    );
    if (!raw) {
      // fenced out: this instance is a zombie for this room
      this.owned.delete(roomCode);
      this.logger.warn({ roomCode, fence }, 'actor: commit fenced out');
      return null;
    }
    const committed = JSON.parse(raw) as Timeline;
    const entry = this.owned.get(roomCode);
    if (entry) entry.timeline = committed;
    return committed;
  }

  /**
   * Every local read-project-commit mutation for a room runs here, in order.
   * Without it, two concurrent operations both read the in-memory timeline
   * before either commit replaced it, and the later one projects from stale
   * state - which is precisely the serialization the class doc promises.
   */
  private enqueue<T>(roomCode: string, op: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(roomCode) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(op);
    this.queues.set(roomCode, next);
    // release the entry once settled, but only while it is still the head:
    // a newer queued operation must not be discarded, and retaining every
    // room's promise forever would grow without bound
    void next
      .catch(() => undefined)
      .finally(() => {
        if (this.queues.get(roomCode) === next) this.queues.delete(roomCode);
      });
    return next;
  }

  applyControl(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    serverNow: number,
    by: string,
  ): Promise<ApplyOutcome> {
    return this.enqueue(roomCode, () =>
      this.applyControlSerial(roomCode, intent, mediaTime, serverNow, by),
    );
  }

  private async applyControlSerial(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    serverNow: number,
    by: string,
  ): Promise<ApplyOutcome> {
    let entry = this.owned.get(roomCode);
    if (!entry) {
      const lease = await this.claim(roomCode);
      if (!lease.mine) {
        // someone else owns this room: forward and let them broadcast
        const delivered = await this.pub.publish(
          this.forwardChannel(lease.owner),
          JSON.stringify({ roomCode, intent, mediaTime, by }),
        );
        if (delivered > 0) return { kind: 'forwarded' };
        // Nobody is subscribed: the owner died between our lease read and
        // this publish. PUBLISH returning 0 is the only signal we get, and
        // dropping the user's control here would lose it silently. Steal the
        // lease and apply locally - safe because the fence check rejects the
        // old owner if it ever comes back.
        this.logger.warn(
          { roomCode, owner: lease.owner },
          'actor: forward undeliverable, reclaiming',
        );
        // compare-and-delete: revoke ONLY the lease we observed, never a
        // newer owner's that appeared while we were publishing
        await this.kv.actorReclaim(
          this.leaseKey(roomCode),
          lease.owner,
          lease.epoch,
        );
        const retaken = await this.claim(roomCode);
        if (!retaken.mine) {
          // P07: a live owner exists after all - forward rather than drop
          const second = await this.pub.publish(
            this.forwardChannel(retaken.owner),
            JSON.stringify({ roomCode, intent, mediaTime, by }),
          );
          return second > 0 ? { kind: 'forwarded' } : { kind: 'missing' };
        }
        const current = await this.get(roomCode);
        if (!current) return { kind: 'missing' };
        this.owned.set(roomCode, { fence: retaken.epoch, timeline: current });
        entry = this.owned.get(roomCode);
      }
      if (!entry) {
        const current = await this.get(roomCode);
        if (!current) return { kind: 'missing' };
        entry = { fence: lease.epoch, timeline: current };
        this.owned.set(roomCode, entry);
      }
    }

    // serialize locally against the in-memory timeline, then commit fenced
    const next = applyControl(entry.timeline, intent, mediaTime, serverNow, by);
    const committed = await this.commit(roomCode, entry.fence, next);
    if (committed) return { kind: 'committed', timeline: committed };
    // Fenced out: another instance took ownership while we held stale
    // authority. The user's intent must not evaporate - forward it to the
    // new owner exactly as a non-owner would.
    const nowLease = await this.claim(roomCode);
    if (nowLease.mine) {
      const fresh = await this.get(roomCode);
      if (!fresh) return { kind: 'missing' };
      this.owned.set(roomCode, { fence: nowLease.epoch, timeline: fresh });
      const retry = await this.commit(
        roomCode,
        nowLease.epoch,
        applyControl(fresh, intent, mediaTime, serverNow, by),
      );
      return retry
        ? { kind: 'committed', timeline: retry }
        : { kind: 'missing' };
    }
    const delivered = await this.pub.publish(
      this.forwardChannel(nowLease.owner),
      JSON.stringify({ roomCode, intent, mediaTime, by }),
    );
    return delivered > 0 ? { kind: 'forwarded' } : { kind: 'missing' };
  }

  applySnapshot(roomCode: string, serverNow: number): Promise<Timeline | null> {
    // shares applyControl's queue: an unserialized sweep could read the
    // pre-control timeline and commit over the control's result
    return this.enqueue(roomCode, () => {
      const entry = this.owned.get(roomCode);
      // only the owner sweeps its rooms; non-owners no-op
      if (!entry) return Promise.resolve(null);
      if (!entry.timeline.isPlaying) return Promise.resolve(null);
      return this.commit(
        roomCode,
        entry.fence,
        snapshot(entry.timeline, serverNow),
      );
    });
  }

  async init(
    roomCode: string,
    videoId: string | null,
    mediaTime: number,
    serverNow: number,
  ): Promise<Timeline> {
    const existing = await this.get(roomCode);
    if (existing) return existing;
    const lease = await this.claim(roomCode);
    if (!lease.mine) {
      // another instance is initializing; read what it wrote (or fall back
      // to a local projection until its commit lands)
      const after = await this.get(roomCode);
      if (after) return after;
    }
    if (lease.mine) {
      // atomic create-if-absent under the fence: concurrent joins collapse
      // onto one committed state instead of each writing a seq
      const raw = await this.kv.actorInit(
        this.leaseKey(roomCode),
        this.timelineKey(roomCode),
        this.instanceId,
        lease.epoch,
        String(mediaTime),
        videoId ?? '',
        String(KEY_TTL_MS),
      );
      if (raw) {
        const created = JSON.parse(raw) as Timeline;
        this.owned.set(roomCode, { fence: lease.epoch, timeline: created });
        return created;
      }
    }
    const fallback = await this.get(roomCode);
    if (fallback) return fallback;
    return {
      v: 1,
      seq: 0,
      storeEpoch: lease.epoch,
      videoId,
      isPlaying: false, // P5: never fast-forward a rehydrated room
      mediaTime,
      stampedAt: serverNow,
      rate: 1,
      reason: 'join',
    };
  }

  async clear(roomCode: string): Promise<void> {
    this.owned.delete(roomCode);
    await this.kv.del(this.timelineKey(roomCode), this.leaseKey(roomCode));
  }

  /** Ownership snapshot for tests and the A/B report. */
  ownedRooms(): string[] {
    return [...this.owned.keys()];
  }

  onApplicationShutdown(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
  }
}
