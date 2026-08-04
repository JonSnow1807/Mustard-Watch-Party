local tl = load_tl(KEYS[1])
if tl == nil then return false end
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
