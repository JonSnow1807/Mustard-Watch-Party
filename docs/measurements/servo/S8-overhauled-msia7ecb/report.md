# Run S8-overhauled-msia7ecb — S8 (overhauled)

25ms + 5% TCP-segment duplication (netem) — dup-ACK pathology

- git SHA: `2e4034c0b74c43044a0a68e2aefc564a2200e5f1`
- started: 2026-08-07T01:44:08.548Z
- clients: 3 · video: `aqz-KE-bpKQ` · ws: `ws://localhost:3102`
- hardware: Chinmays-MacBook-Pro.local · arm64 · node v20.17.0

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| 11ms | 139ms | 140ms | 252ms | 2273 |

All-time (incl. warmup + post-control): P50 11ms, P95 139ms, P99 343ms.

Hard seeks/minute: 0.00

## Convergence after control events

- join@c0: 33.50s
- join@c1: 28.75s
- join@c2: 23.50s
- play@c0: 4.00s
- seek@c0: 6.25s
- play@c0: 3.50s

## getCurrentTime noise floor

Plateau length P50/P95: NaNms / NaNms.
Per-50ms increment P50/P95: NaNms / NaNms.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
