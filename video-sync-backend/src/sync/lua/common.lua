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
  -- videoId falls back to '' (the established nil-encoding) like log_tl
  -- below: a table missing the field would make HSET raise mid-script,
  -- losing the control - and an ioredis resend would repeat it
  -- deterministically, bricking the room until the key's TTL
  redis.call('HSET', key,
    'seq', tl.seq, 'storeEpoch', tl.storeEpoch, 'videoId', tl.videoId or '',
    'isPlaying', tl.isPlaying, 'mediaTime', tl.mediaTime,
    'stampedAt', tl.stampedAt, 'reason', tl.reason, 'by', tl.by or '',
    -- which aligned time window the repair sweep last committed in. Persisted
    -- so the guard in apply_snapshot works across instances; never on the wire.
    'lastSweepWindow', tl.lastSweepWindow or -1)
  redis.call('PEXPIRE', key, ttl)
end
-- Append the committed post-state to the room's append-only log, atomic
-- with the commit because it runs inside the same script. Auto-ID ('*') is
-- legal in scripts on Redis >= 5 (effect-based replication; redis:7 here).
-- MAXLEN ~ trims approximately; the replay checker anchors at the oldest
-- retained entry, so trimming truncates history without corrupting it.
-- Snapshot commits are logged too - formal/SyncExactlyOnce.tla's nosnaplog
-- config is the counterexample for leaving them out.
local function log_tl(logKey, tl, cmdId)
  redis.call('XADD', logKey, 'MAXLEN', '~', 1024, '*',
    'seq', tl.seq, 'storeEpoch', tl.storeEpoch, 'videoId', tl.videoId or '',
    'isPlaying', tl.isPlaying, 'mediaTime', tl.mediaTime,
    'stampedAt', tl.stampedAt, 'reason', tl.reason, 'by', tl.by or '',
    'cmdId', cmdId or '')
  redis.call('PEXPIRE', logKey, 86400000)
end
-- marker: 'dup' when answering a deduplicated command, 'fenced' when a
-- position command's observed video no longer matches the room's. Both
-- mean the same to the caller - reply to the sender with current state,
-- commit nothing, do NOT broadcast - but they are distinct claims: dup
-- says "this command applied", fenced says "this command never will".
-- Stripped before the timeline reaches any client.
local function encode(tl, marker)
  return cjson.encode({
    v = 1, seq = tonumber(tl.seq), storeEpoch = tl.storeEpoch,
    videoId = tl.videoId ~= '' and tl.videoId or nil,
    isPlaying = tl.isPlaying == '1',
    mediaTime = tonumber(tl.mediaTime),
    stampedAt = tonumber(tl.stampedAt),
    rate = 1, reason = tl.reason, by = tl.by ~= '' and tl.by or nil,
    dup = marker == 'dup' or nil,
    fenced = marker == 'fenced' or nil,
  })
end
