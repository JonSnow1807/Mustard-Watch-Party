-- Repair sweep. EVERY instance holding a local socket in a room runs its own
-- 10s sweep timer, so on a 3-instance lab this script was called 3x per period
-- per room: three seq bumps and three fanouts for one repair, scaling linearly
-- with instance count. Worse, the three commits raced, and clients received
-- them out of order often enough to look like lost messages.
--
-- Redis's single-threaded execution already serializes these calls, so the
-- dedup belongs here rather than in a lease: the first caller of a period wins
-- and the rest no-op. No new keys, no ownership, and if the winner dies another
-- instance simply wins the next period.
--
-- ARGV[1] = minimum ms between sweeps (defaults for callers that pass none).
local minInterval = tonumber(ARGV[1]) or 9000
local tl = load_tl(KEYS[1])
if tl == nil then return false end
if tl.isPlaying ~= '1' then return encode(tl) end
local now = now_ms()
local last = tonumber(tl.lastSweepAt) or 0
-- another instance already swept this period: return false so the caller
-- skips its broadcast entirely rather than re-sending a state clients hold
if last > 0 and (now - last) < minInterval then return false end
local elapsed = (now - tonumber(tl.stampedAt)) / 1000.0
tl.seq = tonumber(tl.seq) + 1
tl.mediaTime = tostring(tonumber(tl.mediaTime) + elapsed)
tl.stampedAt = now
tl.lastSweepAt = now
tl.reason = 'snapshot'
tl.by = ''
save_tl(KEYS[1], tl, 86400000)
return encode(tl)
