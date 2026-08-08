# Run S0-overhauled-msjozg1s — S0 (overhauled)

clean loopback (floor; loopback is unrealistically kind)

- git SHA: `c2ffbdf1f1e751d7d599f16771f3bd0edc37aa8a`
- started: 2026-08-08T01:25:38.181Z
- clients: 3 · video: `/media/clicktrack.mp4` (file) · ws: `ws://localhost:3000`
- hardware: Chinmays-MacBook-Pro.local · arm64 · node v20.17.0

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| 6ms | 27ms | 98ms | 262ms | 2256 |

All-time (incl. warmup + post-control): P50 6ms, P95 49ms, P99 229ms.

Hard seeks/minute: 0.00

## Convergence after control events

- join@c0: 29.75s
- join@c1: 25.00s
- join@c2: 20.00s
- play@c0: 0.25s
- seek@c0: 6.00s
- play@c0: 0.25s

## getCurrentTime noise floor

Plateau length P50/P95: n/a / n/a.
Per-50ms increment P50/P95: n/a / n/a.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
