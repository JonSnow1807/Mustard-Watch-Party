-- Claim or renew the room lease. KEYS[1]=lease key. ARGV: instanceId, ttlMs.
-- Redis's single-threaded execution makes claim races impossible: the first
-- claimant wins and later ones see a foreign owner. A NEW claim mints a
-- fresh epoch from the store clock domain, so epochs are totally ordered -
-- which is what lets one mechanism serve as both the zombie fence and the
-- client ordering rule (formal/SyncActor.tla).
local lease = redis.call('HGETALL', KEYS[1])
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
if #lease == 0 then
  redis.call('HSET', KEYS[1], 'owner', ARGV[1], 'epoch', tostring(now))
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return cjson.encode({ owner = ARGV[1], epoch = tostring(now), mine = true })
end
local m = {}
for i = 1, #lease, 2 do m[lease[i]] = lease[i + 1] end
if m.owner == ARGV[1] then
  -- renewal keeps the epoch: the fence only advances on ownership CHANGE
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return cjson.encode({ owner = m.owner, epoch = m.epoch, mine = true })
end
return cjson.encode({ owner = m.owner, epoch = m.epoch, mine = false })
