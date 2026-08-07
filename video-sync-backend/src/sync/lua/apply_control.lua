-- KEYS[1]=room:X:tl  KEYS[2]=room:X:cmd:<cmdId> (dedup record; unused when
-- ARGV[4] is empty)  KEYS[3]=room:X:log (append-only command log)
-- ARGV: intent, mediaTime, by, cmdId, dedupTtlMs,
--       videoId (set-video's next video, ''-encoded null),
--       fenced flag ('1' makes ARGV[8] meaningful; nil/absent = unfenced,
--       which keeps the relay's five-ARGV calls compatible),
--       forVideoId (the video the commander observed, ''-encoded null)
--
-- The idempotency check lives HERE, inside the same atomic script as the
-- commit, because a check-then-apply split across two round trips is the
-- exact race the guard exists to close (formal/SyncExactlyOnce.tla). The
-- concrete duplicate sources it absorbs are not hypothetical: ioredis
-- resends an EVAL whose reply was lost on a dropped connection
-- (autoResendUnfulfilledCommands), and the actor plane's forward publish
-- can be redelivered - both executed this script twice before this guard.
--
-- The ORDER inside the script is load-bearing (formal/SyncSetVideo.tla):
-- dup LOOKUP, then fence check, then commit + dedup RECORD. Recording
-- before the fence check burns the id of a command that never applied,
-- turning its retry into a false "duplicate" (the earlyrecord config's
-- counterexample). Splitting SET NX into GET + SET is race-free here
-- because the whole script is one atomic step.
local tl = load_tl(KEYS[1])
if tl == nil then return false end
local intent = ARGV[1]
if ARGV[4] ~= '' and redis.call('GET', KEYS[2]) then
  -- duplicate: answer with current state, commit nothing. false (not
  -- nil/false-return) is reserved for "room missing", so the dup marker
  -- rides the encoded state instead.
  return encode(tl, 'dup')
end
if ARGV[7] == '1' and intent ~= 'set-video' then
  -- position command minted against a video the room no longer shows: a
  -- seek aimed at video A must never move video B. set-video itself is
  -- exempt - it carries no position and switching is last-writer-wins.
  if (tl.videoId or '') ~= ARGV[8] then
    return encode(tl, 'fenced')
  end
end
if ARGV[4] ~= '' then
  redis.call('SET', KEYS[2], tostring(tonumber(tl.seq) + 1), 'PX', ARGV[5])
end
local now = now_ms()
tl.seq = tonumber(tl.seq) + 1
tl.stampedAt = now
tl.by = ARGV[3]
tl.reason = intent
if intent == 'play' then
  tl.isPlaying = '1'
  tl.mediaTime = ARGV[2]
elseif intent == 'pause' then
  tl.isPlaying = '0'
  tl.mediaTime = ARGV[2]
elseif intent == 'set-video' then
  -- always paused at 0: a new video never autoplays (replay.ts holds this
  -- transition to the same contract)
  tl.videoId = ARGV[6]
  tl.isPlaying = '0'
  tl.mediaTime = '0'
else
  -- seek keeps isPlaying as-is
  tl.mediaTime = ARGV[2]
end
save_tl(KEYS[1], tl, 86400000)
log_tl(KEYS[3], tl, ARGV[4])
return encode(tl)
