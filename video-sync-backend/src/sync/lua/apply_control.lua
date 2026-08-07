-- KEYS[1]=room:X:tl  KEYS[2]=room:X:cmd:<cmdId> (dedup record; unused when
-- ARGV[4] is empty)  ARGV: intent, mediaTime, by, cmdId, dedupTtlMs
--
-- The idempotency check lives HERE, inside the same atomic script as the
-- commit, because a check-then-apply split across two round trips is the
-- exact race the guard exists to close (formal/SyncExactlyOnce.tla). The
-- concrete duplicate sources it absorbs are not hypothetical: ioredis
-- resends an EVAL whose reply was lost on a dropped connection
-- (autoResendUnfulfilledCommands), and the actor plane's forward publish
-- can be redelivered - both executed this script twice before this guard.
local tl = load_tl(KEYS[1])
if tl == nil then return false end
if ARGV[4] ~= '' then
  -- SET NX PX: check and record in one step. nil reply = already applied.
  if redis.call('SET', KEYS[2], tostring(tonumber(tl.seq) + 1),
                'NX', 'PX', ARGV[5]) == false then
    -- duplicate: answer with current state, commit nothing. false (not
    -- nil/false-return) is reserved for "room missing", so the dup marker
    -- rides the encoded state instead.
    return encode(tl, true)
  end
end
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
save_tl(KEYS[1], tl, 86400000)
return encode(tl)
