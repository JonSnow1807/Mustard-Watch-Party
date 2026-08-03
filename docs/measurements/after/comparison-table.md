| scenario (one-way impairment) | baseline P50 / P95 | overhauled P50 / P95 / P99 | convergence after seek |
|---|---|---|---|
| S0 — clean loopback (floor; loopback is unrealistically kind) | 363ms / 255.3s | 31ms / 83ms / 84ms | 0.75s |
| S2 — +150ms each way (~300ms RTT), symmetric | **total failure** (followers never start) | 25ms / 139ms / 140ms | 1.00s |
| S3 — 50±30ms jitter each way | not measured | 68ms / 118ms / 119ms | 1.00s |
| S5 — 25ms + 5% loss (netem) | not measured | 60ms / 97ms / 136ms | 0.75s |
| S6 — asymmetric 120ms up / 20ms down | not measured | 47ms / 120ms / 121ms | 1.00s |

Steady-state hard seeks per minute — S0: 0.00 · S2: 0.00 · S3: 0.00 · S5: 0.25 · S6: 0.00.

3 real Chrome clients, deterministic 240s scenario, Chinmays-MacBook-Pro.local · arm64 · node v20.17.0; runs committed with SHA + scenario + impairment per directory.
