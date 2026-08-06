-- Fenced create-if-absent. KEYS[1]=lease, KEYS[2]=timeline,
-- KEYS[3]=append-only command log.
-- ARGV: instanceId, fence, mediaTime, videoId, ttlMs
-- Atomicity matters as much as fencing: without the create-if-absent check
-- INSIDE the script, N concurrent joins each saw "no state yet" and each
-- committed a seq, so joiners recorded phantom gaps (measured: 25 joins ->
-- seqs 1..25 before the first real broadcast).
local lease = redis.call('HGETALL', KEYS[1])
if #lease == 0 then return false end
local m = {}
for i = 1, #lease, 2 do m[lease[i]] = lease[i + 1] end
if m.owner ~= ARGV[1] or m.epoch ~= ARGV[2] then return false end

local function encode(seq, videoId, isPlaying, mediaTime, stampedAt, reason)
  return cjson.encode({
    v = 1, seq = seq, storeEpoch = ARGV[2],
    videoId = videoId ~= '' and videoId or cjson.null,
    isPlaying = isPlaying == '1', mediaTime = tonumber(mediaTime),
    stampedAt = tonumber(stampedAt), rate = 1, reason = reason,
  })
end

local cur = redis.call('HGETALL', KEYS[2])
if #cur > 0 then
  local c = {}
  for i = 1, #cur, 2 do c[cur[i]] = cur[i + 1] end
  -- cjson drops nil fields, so an absent videoId would arrive as
  -- `undefined` here and `null` from the hash read path; keep them equal
  return cjson.encode({
    v = 1, seq = tonumber(c.seq), storeEpoch = c.storeEpoch,
    videoId = c.videoId ~= '' and c.videoId or cjson.null,
    isPlaying = c.isPlaying == '1', mediaTime = tonumber(c.mediaTime),
    stampedAt = tonumber(c.stampedAt), rate = 1, reason = c.reason,
  })
end

local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
-- seq 0 matches plane A's convention: the first control commits seq 1.
-- isPlaying '0' is P5: never fast-forward a rehydrated room.
redis.call('HSET', KEYS[2],
  'seq', 0, 'storeEpoch', ARGV[2], 'videoId', ARGV[4],
  'isPlaying', '0', 'mediaTime', ARGV[3],
  'stampedAt', tostring(now), 'reason', 'join', 'by', '')
redis.call('PEXPIRE', KEYS[2], ARGV[5])
-- the fence-epoch's birth entry anchors the replay chain
redis.call('XADD', KEYS[3], 'MAXLEN', '~', 1024, '*',
  'seq', 0, 'storeEpoch', ARGV[2], 'videoId', ARGV[4],
  'isPlaying', '0', 'mediaTime', ARGV[3],
  'stampedAt', tostring(now), 'reason', 'join', 'by', '', 'cmdId', '')
redis.call('PEXPIRE', KEYS[3], ARGV[5])
return encode(0, ARGV[4], '0', ARGV[3], tostring(now), 'join')
