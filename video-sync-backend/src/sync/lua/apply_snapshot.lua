local tl = load_tl(KEYS[1])
if tl == nil then return false end
if tl.isPlaying ~= '1' then return encode(tl) end
local now = now_ms()
local elapsed = (now - tonumber(tl.stampedAt)) / 1000.0
tl.seq = tonumber(tl.seq) + 1
tl.mediaTime = tostring(tonumber(tl.mediaTime) + elapsed)
tl.stampedAt = now
tl.reason = 'snapshot'
tl.by = ''
save_tl(KEYS[1], tl, 86400000)
return encode(tl)
