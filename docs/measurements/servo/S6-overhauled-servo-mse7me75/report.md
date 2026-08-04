# Run S6-overhauled-servo-mse7me75 — S6 (overhauled)

asymmetric 120ms up / 20ms down — NTP asymmetry-bias floor

- git SHA: `84ab38682e94412769079df12db686f3f5308a57`
- started: 2026-08-04T05:20:44.545Z
- clients: 3 · video: `aqz-KE-bpKQ` · ws: `ws://localhost:3101`
- hardware: Chinmays-MacBook-Pro.local · arm64 · node v20.17.0

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| 10ms | 86ms | 620ms | 1160ms | 2239 |

All-time (incl. warmup + post-control): P50 10ms, P95 104ms, P99 620ms.

Hard seeks/minute: 0.00

## Convergence after control events

- join@c0: 30.75s
- join@c1: 25.75s
- join@c2: 20.75s
- play@c0: 1.00s
- seek@c0: 1.00s
- play@c0: 4.00s

## getCurrentTime noise floor

Plateau length P50/P95: NaNms / NaNms.
Per-50ms increment P50/P95: NaNms / NaNms.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
