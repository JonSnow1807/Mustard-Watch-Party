-- Repair sweep. EVERY instance holding a local socket in a room runs its own
-- 10s sweep timer, so on a 3-instance lab this script was called 3x per period
-- per room: three seq bumps and three fanouts for one repair, scaling linearly
-- with instance count. Worse, the three commits raced, and clients received
-- them out of order often enough to look like lost messages.
--
-- Redis's single-threaded execution already serializes these calls, so the
-- dedup belongs here rather than in a lease: the first caller of a window wins
-- and the rest no-op. No new keys, no ownership, and if the winner dies another
-- instance simply wins the next window.
--
-- The window is floor(now / period), NOT "elapsed since last sweep". An elapsed
-- test has to pick a threshold, and any threshold below the period lets two
-- staggered instances through inside one period (sweeps at t=0 and t=9.5s both
-- pass a 9s test), while a threshold at exactly the period risks suppressing a
-- lone instance whose timer drifts a millisecond early. Aligned windows have
-- neither problem: at most one commit per window by construction, and a 10s
-- timer always lands in a fresh one.
--
-- ARGV[1] = sweep period in ms (defaults for callers that pass none).
local period = tonumber(ARGV[1]) or 10000
local tl = load_tl(KEYS[1])
if tl == nil then return false end
if tl.isPlaying ~= '1' then return encode(tl) end
local now = now_ms()
local window = math.floor(now / period)
-- another instance already swept this window: return false so the caller
-- skips its broadcast entirely rather than re-sending a state clients hold
if tonumber(tl.lastSweepWindow) == window then return false end
local elapsed = (now - tonumber(tl.stampedAt)) / 1000.0
tl.seq = tonumber(tl.seq) + 1
tl.mediaTime = tostring(tonumber(tl.mediaTime) + elapsed)
tl.stampedAt = now
tl.lastSweepWindow = window
tl.reason = 'snapshot'
tl.by = ''
save_tl(KEYS[1], tl, 86400000)
log_tl(KEYS[2], tl, '')
return encode(tl)
