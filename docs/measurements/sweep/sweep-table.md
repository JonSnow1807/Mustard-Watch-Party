Sweep `sweep-mscpz6fr+mscql2az` · 10 cores (Apple M2 Pro) · 120s cells · SHA `60dbb0ba5d`

| topology | clients | drift P50 | P95 | P99 | lag p99 max | server CPU (cores) | SLO | load-gen |
|---|---|---|---|---|---|---|---|---|
| 1 instance | 10 | 79ms | 167ms | 350ms | 17ms | 0.02 | ok | valid |
| 3 instances | 10 | 80ms | 164ms | 348ms | 17ms | 0.03 | ok | valid |
| 1 instance | 25 | 77ms | 169ms | 390ms | 20ms | 0.04 | ok | valid |
| 3 instances | 25 | 80ms | 169ms | 358ms | 18ms | 0.06 | ok | valid |
| 1 instance | 50 | 76ms | 164ms | 346ms | 22ms | 0.08 | ok | valid |
| 3 instances | 50 | 71ms | 171ms | 375ms | 18ms | 0.08 | ok | valid |
| 1 instance | 100 | 72ms | 164ms | 345ms | 37ms | 0.15 | ok | valid |
| 3 instances | 100 | 77ms | 164ms | 355ms | 24ms | 0.15 | ok | valid |
| 1 instance | 250 | 74ms | 165ms | 382ms | 62ms | 0.51 | ok | valid |
| 3 instances | 250 | 74ms | 166ms | 381ms | 90ms | 0.37 | ok | valid |

**1 instance:** no SLO breach on any valid cell in this sweep.

**3 instances:** no SLO breach on any valid cell in this sweep.
