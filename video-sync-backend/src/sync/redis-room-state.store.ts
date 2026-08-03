import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { REDIS_KV } from '../redis/redis.module';
import { ControlIntent, Timeline } from '../shared/sync-protocol';
import { RoomStateStore } from './room-state.store';

// Redis hash per room is the source of truth; ONE Lua script per mutation is
// the serializer - Redis's single-threaded execution orders concurrent
// control events from different instances as (seq n, n+1) with no locks.
// Every timestamp comes from redis.call('TIME') INSIDE the script (D6): the
// authoritative clock domain is Redis's, so instance wall-clock skew can
// never masquerade as drift. Broadcasts always carry the state the script
// returned, never a local copy. TTL 24h refreshed on write = crash-safe GC;
// rehydration mints a fresh storeEpoch (clients treat any new epoch as
// newer, so a Redis flush can't strand them at a high stale seq).

const KEY_TTL_MS = 24 * 60 * 60 * 1000;

const LUA_COMMON = `
local function now_ms()
  local t = redis.call('TIME')
  return t[1] * 1000 + math.floor(t[2] / 1000)
end
local function load_tl(key)
  local h = redis.call('HGETALL', key)
  if #h == 0 then return nil end
  local tl = {}
  for i = 1, #h, 2 do tl[h[i]] = h[i + 1] end
  return tl
end
local function save_tl(key, tl, ttl)
  redis.call('HSET', key,
    'seq', tl.seq, 'storeEpoch', tl.storeEpoch, 'videoId', tl.videoId,
    'isPlaying', tl.isPlaying, 'mediaTime', tl.mediaTime,
    'stampedAt', tl.stampedAt, 'reason', tl.reason, 'by', tl.by or '')
  redis.call('PEXPIRE', key, ttl)
end
local function encode(tl)
  return cjson.encode({
    v = 1, seq = tonumber(tl.seq), storeEpoch = tl.storeEpoch,
    videoId = tl.videoId ~= '' and tl.videoId or nil,
    isPlaying = tl.isPlaying == '1',
    mediaTime = tonumber(tl.mediaTime),
    stampedAt = tonumber(tl.stampedAt),
    rate = 1, reason = tl.reason, by = tl.by ~= '' and tl.by or nil,
  })
end
`;

// KEYS[1]=room key, ARGV: intent, mediaTime, by
const LUA_APPLY_CONTROL = `${LUA_COMMON}
local tl = load_tl(KEYS[1])
if tl == nil then return false end
local now = now_ms()
local intent = ARGV[1]
tl.seq = tonumber(tl.seq) + 1
tl.stampedAt = now
tl.mediaTime = ARGV[2]
tl.by = ARGV[3]
tl.reason = intent
if intent == 'play' then
  tl.isPlaying = '1'
elseif intent == 'pause' then
  tl.isPlaying = '0'
end
-- seek keeps isPlaying as-is
save_tl(KEYS[1], tl, ${KEY_TTL_MS})
return encode(tl)
`;

// KEYS[1]=room key
const LUA_APPLY_SNAPSHOT = `${LUA_COMMON}
local tl = load_tl(KEYS[1])
if tl == nil then return false end
if tl.isPlaying ~= '1' then return encode(tl) end
local now = now_ms()
local elapsed = (now - tonumber(tl.stampedAt)) / 1000.0
tl.seq = tonumber(tl.seq) + 1
tl.mediaTime = tostring(tonumber(tl.mediaTime) + elapsed)
tl.stampedAt = now
tl.reason = 'snapshot'
tl.by = ''
save_tl(KEYS[1], tl, ${KEY_TTL_MS})
return encode(tl)
`;

// KEYS[1]=room key, ARGV: videoId, mediaTime, epoch — first writer wins (P5)
const LUA_INIT = `${LUA_COMMON}
local existing = load_tl(KEYS[1])
if existing ~= nil then return encode(existing) end
local now = now_ms()
local tl = {
  seq = 0, storeEpoch = ARGV[3], videoId = ARGV[1],
  isPlaying = '0', mediaTime = ARGV[2], stampedAt = now,
  reason = 'join', by = '',
}
save_tl(KEYS[1], tl, ${KEY_TTL_MS})
return encode(tl)
`;

interface RedisWithCommands extends Redis {
  mustardApplyControl(
    key: string,
    intent: string,
    mediaTime: string,
    by: string,
  ): Promise<string | null>;
  mustardApplySnapshot(key: string): Promise<string | null>;
  mustardInit(
    key: string,
    videoId: string,
    mediaTime: string,
    epoch: string,
  ): Promise<string>;
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
  ): Promise<Timeline | null> {
    const result = await this.redis.mustardApplyControl(
      this.key(roomCode),
      intent,
      String(mediaTime),
      by,
    );
    return this.parse(result);
  }

  async applySnapshot(
    roomCode: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _serverNow: number,
  ): Promise<Timeline | null> {
    const result = await this.redis.mustardApplySnapshot(this.key(roomCode));
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
      randomBytes(6).toString('hex'),
    );
    const parsed = this.parse(result);
    if (!parsed) throw new Error(`init failed for room ${roomCode}`);
    return parsed;
  }

  async clear(roomCode: string): Promise<void> {
    await this.redis.del(this.key(roomCode));
  }
}
