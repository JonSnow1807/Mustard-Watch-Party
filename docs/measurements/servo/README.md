# Predictive servo — real-browser measurements

The predictive clock-discipline controller (M9) measured on three real Chrome
clients across the must-have impairment matrix, same harness and hardware as
`../after/` (the reactive controller) and `../baseline/`.

| scenario | reactive P50 / P95 | servo P50 / P95 |
|---|---|---|
| S0 clean | 31 / 83ms | **16 / 49ms** |
| S2 +300ms RTT | 25 / 139ms | **19 / 48ms** |
| S3 50±30ms jitter | 68 / 118ms | **23 / 79ms** |
| S5 25ms + 5% loss | 60 / 97ms | **11 / 29ms** |
| S6 asym 120/20ms | 47 / 120ms | **10 / 86ms** |

The servo wins everywhere, most decisively under packet loss: it holds the
error near zero continuously rather than letting drift grow to a correction
threshold and then seeking. S3 and S6 keep the higher P99 tails (647ms,
620ms) that jitter and asymmetry impose on any scheme — the asymmetry bias
in particular is irreducible (see `../after/` and SYNC_DESIGN §3).

These runs promoted the servo to the engine default; `?controller=R` selects
the reactive arm, which remains the automatic fallback wherever the
per-video fractional-rate probe fails.
