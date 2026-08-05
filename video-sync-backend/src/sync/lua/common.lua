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
    'stampedAt', tl.stampedAt, 'reason', tl.reason, 'by', tl.by or '',
    -- which aligned time window the repair sweep last committed in. Persisted
    -- so the guard in apply_snapshot works across instances; never on the wire.
    'lastSweepWindow', tl.lastSweepWindow or -1)
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
