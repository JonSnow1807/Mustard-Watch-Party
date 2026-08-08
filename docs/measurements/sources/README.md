# Source matrix — every player, same sync

Five committed runs measuring cross-client drift per media source, after
the multi-source player work (shared classifier → shell + mounts →
HLS/Vimeo adapters). Same deterministic 3-browser scenario and hardware as
the main matrix; `meta.json` in each run stamps the URL measured
(`videoUrl`), the classifier's verdict (`videoSource`), the derived
`videoId`, and the SHA.

| run | source | scenario | steady P50 / P95 / P99 | steady samples |
|---|---|---|---|---|
| `S0-overhauled-msjozg1s` | file (`/media/clicktrack.mp4`) | S0 | 6 / 27 / 98ms | 2,256 |
| `S2-overhauled-msjpmaci` | file | S2 | 6 / 18 / 27ms | 2,269 |
| `S0-overhauled-msjp5cuc` | hls (`/media/hls/clicktrack.m3u8`) | S0 | 5 / 19 / 40ms | 2,271 |
| `S2-overhauled-msjpaix6` | hls | S2 | 7 / 18 / 25ms | 2,273 |
| `S0-overhauled-msjpgb9o` | vimeo (`vimeo.com/1084537`) | S0 | 8 / 38 / 125ms | 2,280 |

Fixtures are generated, not committed (`public/media/` is gitignored):
`sync-harness/scripts/make-clicktrack.sh` then `make-hls-fixture.sh`. The
Vimeo arm plays Blender's official Big Buck Bunny upload — the same
content as the YouTube arm, so the comparison compares players, not
videos. The Vimeo player's own CDN traffic goes direct and unimpaired,
per the methodology (only app traffic traverses a proxy).

Reading the numbers: the native arms beat the YouTube arm's floor (16/49ms
at S0) because a same-origin media element reports genuine `currentTime` —
there is no postMessage quantization to edge-reconstruct around. Vimeo's
promise-only SDK is modeled locally from ~4Hz `timeupdate` events; the
noisier readout costs ~1.5 corrective seeks/min at S0 (the native arms
take none) and a wider P99.

**A discarded first attempt, recorded on purpose.** The first file-arm
session produced S0 "P50 1542ms" — which turned out to measure a paused
room, not sync: the cold-launched browser stalled all three pages past the
15s socket ping deadline, all sockets dropped together, the emptied room
was released and re-initialized *paused* (P5, by design), and the players
obediently sat at 7.1s in perfect agreement. The tell was 23 steady
samples where a healthy run has ~2,270, plus a full re-join wave in the
backend log. Both replacement runs were re-measured on a warm browser
with the machine otherwise idle, and every committed run here clears
2,000+ steady samples. The diagnostic that pinned it —
`sync-harness/src/debug-pause.ts`, three staggered browser clients plus a node-side
socket tap printing every timeline broadcast — is committed for the next
time a run looks too strange to trust.
