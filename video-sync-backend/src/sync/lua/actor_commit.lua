-- Fenced commit. KEYS[1]=lease, KEYS[2]=timeline, KEYS[3]=cmd dedup record
-- ARGV: instanceId, fence, isPlaying, mediaTime, reason, by, videoId,
--       ttlMs, cmdId, dedupTtlMs
-- A commit is accepted ONLY if the caller still holds the lease at the fence
-- it believes it owns. This is the guard a revived zombie fails - the case
-- the TLA+ spec exists to check (NoStaleFenceWrite).
--
-- The cmdId dedup lives INSIDE the fenced step and its record is
-- fence-INDEPENDENT: seq restarts when the fence advances, so (epoch, seq)
-- cannot identify a command across an owner handoff, but the cmd key can -
-- a command applied by the old owner is answered as a duplicate by the new
-- one instead of being applied again. The forward publish that delivers
-- commands to owners can itself be redelivered, which is exactly the
-- double-apply this closes.
local lease = redis.call('HGETALL', KEYS[1])
if #lease == 0 then return false end
local m = {}
for i = 1, #lease, 2 do m[lease[i]] = lease[i + 1] end
if m.owner ~= ARGV[1] or m.epoch ~= ARGV[2] then return false end

local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
local seq = 1
local cur = redis.call('HGETALL', KEYS[2])
local c = {}
if #cur > 0 then
  for i = 1, #cur, 2 do c[cur[i]] = cur[i + 1] end
  -- seq restarts when the fence advances: (epoch, seq) stays ordered
  if c.storeEpoch == ARGV[2] then seq = tonumber(c.seq) + 1 end
end
if ARGV[9] ~= '' and #cur > 0 then
  if redis.call('SET', KEYS[3], tostring(seq), 'NX', 'PX', ARGV[10])
     == false then
    -- duplicate: answer with the CURRENT committed state, commit nothing.
    -- false is reserved for fenced-out (the caller drops ownership on it),
    -- so the dup marker rides the encoded state instead.
    return cjson.encode({
      v = 1, seq = tonumber(c.seq), storeEpoch = c.storeEpoch,
      videoId = c.videoId ~= '' and c.videoId or nil,
      isPlaying = c.isPlaying == '1',
      mediaTime = tonumber(c.mediaTime), stampedAt = tonumber(c.stampedAt),
      rate = 1, reason = c.reason, by = c.by ~= '' and c.by or nil,
      dup = true,
    })
  end
end
redis.call('HSET', KEYS[2],
  'seq', seq, 'storeEpoch', ARGV[2], 'videoId', ARGV[7],
  'isPlaying', ARGV[3], 'mediaTime', ARGV[4],
  'stampedAt', tostring(now), 'reason', ARGV[5], 'by', ARGV[6])
redis.call('PEXPIRE', KEYS[2], ARGV[8])
return cjson.encode({
  v = 1, seq = seq, storeEpoch = ARGV[2],
  videoId = ARGV[7] ~= '' and ARGV[7] or nil,
  isPlaying = ARGV[3] == '1',
  mediaTime = tonumber(ARGV[4]), stampedAt = now,
  rate = 1, reason = ARGV[5], by = ARGV[6] ~= '' and ARGV[6] or nil,
})
