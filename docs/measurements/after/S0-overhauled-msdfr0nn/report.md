# Run S0-overhauled-msdfr0nn — S0 (overhauled)

clean loopback (floor; loopback is unrealistically kind)

- git SHA: `57b730a8610d96f23b248a2286f27ef4ced167e6`
- started: 2026-08-03T16:20:31.060Z
- clients: 3 · video: `aqz-KE-bpKQ` · ws: `ws://localhost:3000`
- hardware: Chinmays-MacBook-Pro.local · arm64 · node v20.17.0

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| 31ms | 83ms | 84ms | 85ms | 2256 |

All-time (incl. warmup + post-control): P50 31ms, P95 83ms, P99 84ms.

Hard seeks/minute: 0.00

## Convergence after control events

- join@c0: 33.75s
- join@c1: 29.00s
- join@c2: 24.00s
- play@c0: 4.25s
- seek@c0: 0.75s
- play@c0: 0.75s

## getCurrentTime noise floor

Plateau length P50/P95: NaNms / NaNms.
Per-50ms increment P50/P95: NaNms / NaNms.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
