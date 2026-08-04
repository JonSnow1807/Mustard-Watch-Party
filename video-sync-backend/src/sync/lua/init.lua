local existing = load_tl(KEYS[1])
if existing ~= nil then return encode(existing) end
local now = now_ms()
local tl = {
  seq = 0, storeEpoch = tostring(now), videoId = ARGV[1],
  isPlaying = '0', mediaTime = ARGV[2], stampedAt = now,
  reason = 'join', by = '',
}
save_tl(KEYS[1], tl, 86400000)
return encode(tl)
