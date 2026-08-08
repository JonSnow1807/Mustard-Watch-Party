# Run S0-overhauled-msjp5cuc — S0 (overhauled)

clean loopback (floor; loopback is unrealistically kind)

- git SHA: `c2ffbdf1f1e751d7d599f16771f3bd0edc37aa8a`
- started: 2026-08-08T01:30:13.998Z
- clients: 3 · video: `/media/hls/clicktrack.m3u8` (hls) · ws: `ws://localhost:3000`
- hardware: Chinmays-MacBook-Pro.local · arm64 · node v20.17.0

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| 5ms | 19ms | 40ms | 76ms | 2271 |

All-time (incl. warmup + post-control): P50 5ms, P95 20ms, P99 61ms.

Hard seeks/minute: 0.00

## Convergence after control events

- join@c0: 29.75s
- join@c1: 25.00s
- join@c2: 20.00s
- play@c0: 0.25s
- seek@c0: 0.50s
- play@c0: 0.25s

## getCurrentTime noise floor

Plateau length P50/P95: n/a / n/a.
Per-50ms increment P50/P95: n/a / n/a.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
