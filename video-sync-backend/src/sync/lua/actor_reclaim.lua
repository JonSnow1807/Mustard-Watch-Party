-- Compare-and-delete a lease. KEYS[1]=lease. ARGV: observedOwner, observedFence
-- An unconditional DEL is unsafe: between observing a lease and deciding to
-- revoke it, the old owner's key can expire and a DIFFERENT instance can
-- claim - the DEL would then destroy a valid, current lease. Only remove the
-- exact lease that was observed.
local lease = redis.call('HGETALL', KEYS[1])
if #lease == 0 then return 1 end          -- already gone: nothing to revoke
local m = {}
for i = 1, #lease, 2 do m[lease[i]] = lease[i + 1] end
if m.owner == ARGV[1] and m.epoch == ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0                                   -- someone else owns it now
