Sweep `sweep-mshvizoy (+sweep-mshw7yw5 size-10 re-run)` · 10 cores (Apple M2 Pro) · 120s cells · SHA `c52162d4cf`

| topology | clients | drift P50 | P95 | P99 | lag p99 max | server CPU (cores) | gaps/reord/dups | SLO | load-gen |
|---|---|---|---|---|---|---|---|---|---|
| 1 instance | 10 | 76ms | 116ms | 315ms | 17ms | 0.02 | 0/0/0 | ok | valid |
| 3 instances | 10 | 74ms | 117ms | 314ms | 18ms | 0.04 | 0/0/84 | ok | valid |
| 1 instance | 25 | 73ms | 120ms | 226ms | 17ms | 0.04 | 0/0/0 | ok | valid |
| 3 instances | 25 | 73ms | 141ms | 317ms | 17ms | 0.06 | 0/0/170 | ok | valid |
| 1 instance | 50 | 58ms | 140ms | 263ms | 20ms | 0.07 | 0/0/0 | ok | valid |
| 3 instances | 50 | 55ms | 140ms | 262ms | 22ms | 0.08 | 0/0/396 | ok | valid |
| 1 instance | 100 | 70ms | 149ms | 330ms | 32ms | 0.14 | 0/0/0 | ok | valid |
| 3 instances | 100 | 68ms | 151ms | 331ms | 23ms | 0.13 | 0/0/670 | ok | valid |
| 1 instance | 250 | 63ms | 158ms | 340ms | 42ms | 0.49 | 0/0/0 | ok | valid |
| 3 instances | 250 | 69ms | 158ms | 340ms | 65ms | 0.36 | 0/0/1668 | ok | valid |

**1 instance:** no SLO breach on any valid cell in this sweep.

**3 instances:** no SLO breach on any valid cell in this sweep.
