Sweep `sweep-msex1u7w (+msext3tp re-runs)` · 10 cores (Apple M2 Pro) · 120s cells · SHA `d6d33c9b3b`

| topology | clients | drift P50 | P95 | P99 | lag p99 max | server CPU (cores) | SLO | load-gen |
|---|---|---|---|---|---|---|---|---|
| 1 instance | 10 | 74ms | 116ms | 312ms | 17ms | 0.02 | ok | valid |
| 3 instances | 10 | 76ms | 117ms | 317ms | 18ms | 0.04 | ok | valid |
| 1 instance | 25 | 69ms | 122ms | 262ms | 16ms | 0.04 | ok | valid |
| 3 instances | 25 | 71ms | 136ms | 263ms | 17ms | 0.06 | ok | valid |
| 1 instance | 50 | 58ms | 141ms | 264ms | 27ms | 0.07 | ok | valid |
| 3 instances | 50 | 57ms | 146ms | 302ms | 20ms | 0.09 | ok | valid |
| 1 instance | 100 | 67ms | 147ms | 332ms | 83ms | 0.17 | ok | valid |
| 3 instances | 100 | 65ms | 149ms | 325ms | 28ms | 0.14 | ok | valid |
| 1 instance | 250 | 67ms | 155ms | 336ms | 130ms | 0.56 | BREACH | valid |
| 3 instances | 250 | 68ms | 156ms | 339ms | 76ms | 0.37 | ok | valid |

**1 instance knee:** SLO breach at n=250 (drift P95 155ms, lag 130ms).

**3 instances:** no SLO breach on any valid cell in this sweep.
