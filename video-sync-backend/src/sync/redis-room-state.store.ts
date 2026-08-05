import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_KV } from '../redis/redis.module';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import {
  ApplyOutcome,
  RoomStateStore,
  SWEEP_DEDUP_PERIOD_MS,
} from './room-state.store';

// Redis hash per room is the source of truth; ONE Lua script per mutation is
// the serializer - Redis's single-threaded execution orders concurrent
// control events from different instances as (seq n, n+1) with no locks.
// Every timestamp comes from redis.call('TIME') INSIDE the script (D6): the
// authoritative clock domain is Redis's, so instance wall-clock skew can
// never masquerade as drift. Broadcasts always carry the state the script
// returned, never a local copy. TTL 24h refreshed on write = crash-safe GC;
// rehydration mints a fresh storeEpoch (clients treat any new epoch as
// newer, so a Redis flush can't strand them at a high stale seq).

// The Lua lives in ./lua/*.lua - ONE source of truth shared verbatim with
// the Go relay (relay-go loads the same files). nest-cli copies them into
// dist as assets.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LUA_DIR = join(__dirname, 'lua');
const LUA_COMMON = readFileSync(join(LUA_DIR, 'common.lua'), 'utf8');
const lua = (name: string): string =>
  LUA_COMMON + readFileSync(join(LUA_DIR, name), 'utf8');
const LUA_APPLY_CONTROL = lua('apply_control.lua');
const LUA_APPLY_SNAPSHOT = lua('apply_snapshot.lua');
const LUA_INIT = lua('init.lua');

interface RedisWithCommands extends Redis {
  mustardApplyControl(
    key: string,
    intent: string,
    mediaTime: string,
    by: string,
  ): Promise<string | null>;
  mustardApplySnapshot(key: string, periodMs: string): Promise<string | null>;
  mustardInit(key: string, videoId: string, mediaTime: string): Promise<string>;
}

@Injectable()
export class RedisRoomStateStore implements RoomStateStore {
  private redis: RedisWithCommands;

  constructor(@Inject(REDIS_KV) redis: Redis) {
    redis.defineCommand('mustardApplyControl', {
      numberOfKeys: 1,
      lua: LUA_APPLY_CONTROL,
    });
    redis.defineCommand('mustardApplySnapshot', {
      numberOfKeys: 1,
      lua: LUA_APPLY_SNAPSHOT,
    });
    redis.defineCommand('mustardInit', { numberOfKeys: 1, lua: LUA_INIT });
    this.redis = redis as RedisWithCommands;
  }

  private key(roomCode: string): string {
    return `room:${roomCode}:tl`;
  }

  private parse(json: string | null): Timeline | null {
    if (!json) return null;
    const raw = JSON.parse(json) as Timeline & { videoId?: string };
    return { ...raw, videoId: raw.videoId ?? null };
  }

  async get(roomCode: string): Promise<Timeline | null> {
    const h = await this.redis.hgetall(this.key(roomCode));
    if (!h || Object.keys(h).length === 0) return null;
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

  async applyControl(
    roomCode: string,
    intent: ControlIntent,
    mediaTime: number,
    _serverNow: number, // stamping happens inside Lua from redis TIME (D6)
    by: string,
  ): Promise<ApplyOutcome> {
    const result = await this.redis.mustardApplyControl(
      this.key(roomCode),
      intent,
      String(mediaTime),
      by,
    );
    const timeline = this.parse(result);
    return timeline ? { kind: 'committed', timeline } : { kind: 'missing' };
  }

  async applySnapshot(
    roomCode: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _serverNow: number,
  ): Promise<Timeline | null> {
    // Every instance with a local socket in the room runs its own sweep
    // timer, so this is called once per instance per period. The script
    // dedups: the first caller of a window commits, the rest return null and
    // their callers skip broadcasting.
    const result = await this.redis.mustardApplySnapshot(
      this.key(roomCode),
      String(SWEEP_DEDUP_PERIOD_MS),
    );
    return this.parse(result);
  }

  async init(
    roomCode: string,
    videoId: string | null,
    mediaTime: number,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _serverNow: number,
  ): Promise<Timeline> {
    const result = await this.redis.mustardInit(
      this.key(roomCode),
      videoId ?? '',
      String(mediaTime),
    );
    const parsed = this.parse(result);
    if (!parsed) throw new Error(`init failed for room ${roomCode}`);
    return parsed;
  }

  async clear(roomCode: string): Promise<void> {
    await this.redis.del(this.key(roomCode));
  }
}
