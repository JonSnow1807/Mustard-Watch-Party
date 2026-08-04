# Scaling

How the sync plane runs on N instances, why the coordination design looks
the way it does, and what the load sweeps measured. Companion to
[SYNC_DESIGN.md](SYNC_DESIGN.md).

## 1. Coordination: Redis hash + one Lua script per mutation

**Decision:** with `REDIS_URL` set, the room timeline lives in a Redis hash
and every mutation is a single Lua script: read → validate → `seq+1` → HSET
→ PEXPIRE → return the committed state. Redis's single-threaded script
execution *is* the serializer — concurrent control events from different
instances commit as `(seq n, n+1)` with no locks, and every broadcast
carries exactly the state the script returned, never a local copy.

Measured on the live 3-instance lab **[lab]** — `verify-m6.ts` prints this
and asserts on it, but writes no artifact: a 10-control blast split across
two instances produced 13 broadcasts (10 controls plus re-anchor sweeps),
13 unique seqs, strictly monotone.

**Rejected alternative — in-memory authority with pub/sub invalidation:**
requires room→instance ownership (leases, failover, fencing, split-brain
handling). That *is* the better endgame at large scale — it restores
in-memory speed and O(local) fanout — and it is exactly what the M13
room-actor track builds and measures head-to-head. As the default plane it
is disproportionate: the timeline is ~7 tiny fields written a few times a
minute per room, and one Redis RTT (~0.2–1ms local) is noise against the
network jitter the drift controller already absorbs.

## 2. One clock domain (D6)

"The server restamps events" is ill-defined across 3 instances — their
wall clocks disagree, and that skew would masquerade as playback drift.
Every timestamp therefore comes from `redis.call('TIME')` **inside** the
Lua scripts, and each instance maintains a smoothed local→Redis offset
(TIME round-trips every 5s, EMA-8) through which it converts the
`sync:clock` ack stamps. Identity transform without Redis. Measured
ack-offset spread across the 3 live lab instances: **4ms** **[lab]** —
`verify-m6.ts` computes and gates this (< 50ms) on the console; no run
directory is written, so the figure is reproducible but not citable.

## 3. Failure model

- **Instance crash** (verified with `docker kill` mid-playback): clients
  reconnect through the load balancer to survivors and rejoin; the timeline
  is in Redis, so playback state survives with the same `storeEpoch` — no
  reset, no snap to zero.
- **Redis restart/flush**: the store rehydrates from the debounced Postgres
  copy — always paused (P5) — under a **fresh random `storeEpoch`**.
  Clients treat any new epoch as newer, so they can never be stranded at a
  high stale seq. This is also why the free-tier production Redis needs no
  persistence: losing it is a designed-for event.
- **Redis down**: control events fail fast with a typed error (the KV
  client has no offline queue); `/health` should surface degradation. No
  silent split-brain fallback.
- **Pub/sub blip**: the adapter can drop broadcasts; the 10s snapshot sweep
  is the repair channel, and `(storeEpoch, seq)` ordering makes redundant
  repair harmless.

## 4. Sticky sessions, honestly

The lab speaks WebSocket-only through nginx `least_conn` — one long-lived
connection per client needs no affinity, so balancing is honest. HTTP
long-polling across instances *would* need affinity; production runs a
single instance of this same Redis code path (identical build, N=1), where
the browser's polling fallback is harmless. Multi-instance correctness is
proven by the lab and the nightly workflow, not by paying for idle replicas.

## 5. Load characterization

Method: bot fleets (the real protocol, real JWT path, simulated players)
against 1 instance vs 3 instances behind nginx; each cell 120s with
scripted control events; per-instance `/metrics` scraped every 5s
(event-loop lag p99, CPU, RSS, connected clients); load-generator host load
recorded per cell and cells above 0.7 load/core flagged self-skewed. SLOs:
bot P95 vs-timeline drift ≤ 250ms (set above the fleet's simulated-player
floor, measured at P95 116–156ms across this sweep); event-loop lag p99
≤ 100ms. The knee is the smallest N breaching an SLO, attributed via the
correlated server metric.

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

**The knee, and what causes it.** A single instance **breaches at 250 clients
in one room**: event-loop lag p99 hits 130ms against a 100ms SLO while CPU
climbs to 0.56 cores. Three instances carry the same 250 clients at 76ms lag
and 0.37 cores total — the fanout work that saturates one event loop is
spread across three, which is exactly the benefit the topology exists for and
the first sweep was too coarse to show.

Client-visible drift is barely affected across the whole range (P95 116 →
156ms from 10 to 250 clients; the 1-vs-3-instance difference per cell spans
1–14ms with no consistent direction, i.e. within run-to-run noise):
coordination and fanout are not what bounds sync quality here — the
simulated player's own latency is. The server metrics are where load shows
up, which is why the knee is defined on event-loop lag rather than drift.

Every cell passed load-gen validity (<0.7 load/core). Sizes 10 and 50 were
re-run after the first pass flagged them self-skewed; only the re-runs are
published — the first-pass cell files were overwritten by the re-run and
were not retained.

**One cell reports seq gaps.** `three-25` records **59** `seqGaps`; every
other cell records zero (`sweep-summary.json`, `botSummary.seqGaps`). Seq
gaps are not one of the two SLOs above, so the cell is marked "ok" by the
knee criterion and the table has no column for them — which would leave a
non-zero integrity count invisible to anyone reading only the table. It is
surfaced here instead. A gap is a bot observing a jump in `(storeEpoch,
seq)`, which a dropped or reordered fanout message produces without any
store-side defect; the store's own serialization is checked separately and
directly (`verify-m6.ts`, and the CI gate fails on any gap). It is called
out because a number that appears in a committed artifact and nowhere in
the prose is exactly the kind of thing this document should not bury, and
because it has not been root-caused — it warrants a re-run of that cell
before the 3-instance topology is claimed clean on integrity.

Charts: [drift](measurements/sweep/charts/sweep-drift.svg) ·
[event-loop lag](measurements/sweep/charts/sweep-lag.svg) ·
[full run](measurements/sweep/)

## 6. Production topology and cost

Render Starter backend (~$7/mo, always-on WebSockets) running the Redis
code path at N=1 · Neon Postgres free tier · Render Key-Value free (no
persistence — by design, see §3) · Vercel Hobby frontend. The same build
that runs as 3 instances in the lab runs as 1 in prod; scale-out is a
dial, not a rewrite.

## 7. Known limitations

Voice rosters are per-instance (the WebRTC mesh is not the sync plane and
small rooms don't need an SFU yet). REST room mutation trusts the request
body (socket control does not — it derives identity from the verified JWT).
Cross-region rooms need the M13 room-actor/ownership design — a shared
single-region Redis is the deliberate ceiling of plane A.
