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
two instances is assigned **unique, contiguous** seqs (that is the
serialization claim, and the gate). Arrival order at any one subscriber is
*not* asserted: the broadcasts originate from two publisher instances, the
adapter gives no cross-publisher ordering, and clients order by
`(storeEpoch, seq)` precisely because of that — an earlier version of the
check gated on arrival monotonicity, which passed for weeks on timing luck
and failed on the first CI runner that interleaved the publishers.

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
  copy — always paused (P5) — under a **fresh `storeEpoch` minted from redis
  TIME**, so epochs are totally ordered by birth. The wording that used to
  live here — "random epoch, clients treat any new epoch as newer" — is the
  exact rule `formal/SyncTimeline.tla` REFUTES (`SyncTimeline_naive.cfg`): a
  client that accepts any different epoch can be dragged backwards by a
  stale broadcast from the old epoch. The client rule is a total order,
  epoch first then seq (`shared/sync-core/timeline.ts isNewer`), and it is
  sound only because mint-time epochs are comparable at all. The
  implementation was always the ordered one; this paragraph was written
  before the model check and never corrected. This is also why the
  free-tier production Redis needs no persistence: losing it is a
  designed-for event.
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
floor, measured at P95 116–158ms across the current sweep); event-loop lag
p99 ≤ 100ms. The knee is the smallest N breaching an SLO, attributed via the
correlated server metric.

### Current matrix — post-sweep-dedup build

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

**No SLO breach on any cell, either topology, up to 250 clients in one
room.** Every cell passed load-gen validity (0.28–0.45 load/core against the
0.7 gate). The size-10 cells are a re-run minutes after the first pass: the
first attempt ran ~2 minutes after `compose up` and `three-10` failed at bot
*registration* with a 502 from nginx (backends still booting) before any
measurement began — recorded in the summary's `note`, and one-10 was re-run
alongside it so the size-10 row is a single-conditions pair.

**The integrity columns are the point of this re-run.** Gaps and reorders
are zero on every cell. Duplicates appear only on the 3-instance topology
and scale with n (84 → 170 → 396 → 670 → 1668) — these are the losing
instances' local re-anchors landing alongside the window-winner's broadcast,
exactly the designed signature of the sweep dedup (below), idempotent and
dropped by `isNewer`.

**The previously published knee did not reproduce.** The earlier sweep
(retained below) measured a one-instance event-loop-lag breach at 250
clients: 130ms p99 against the 100ms SLO. This run measures **42ms** on the
same cell — no breach anywhere, so the knee on this hardware is somewhere
above 250 clients per room and is currently *unlocated*. The sweep dedup
cannot explain the difference (a single instance has exactly one sweeper
either way); the salient environmental change is that the earlier run's
Docker VM had ~26 days of uptime while this run followed a host reboot. The
attribution is therefore *withdrawn rather than replaced*: the earlier
"fanout saturates one event loop, three instances spread it" story matched
that run's numbers but is not supported by this one — here the 3-instance
lag at 250 (65ms) is actually *higher* than 1-instance (42ms). Both runs
stay committed; a knee claim will return when a breach reproduces.

Client-visible drift is barely affected across the whole range (P95 116 →
158ms from 10 to 250 clients, near-identical between topologies):
coordination and fanout are not what bounds sync quality here — the
simulated player's own latency is. The server metrics are where load shows
up, which is why the knee is defined on event-loop lag rather than drift.

Charts: [drift](measurements/sweep2/charts/sweep-drift.svg) ·
[event-loop lag](measurements/sweep2/charts/sweep-lag.svg) ·
[full run](measurements/sweep2/)

### Previous matrix — pre-dedup build (retained)

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

This matrix was measured on the build *before* the sweep dedup, with the
Docker VM ~26 days up. Its `three-25` cell records `seqGaps: 59` — the
metric artifact root-caused below, not a real loss — and its one-instance
breach at 250 is the non-reproduced knee discussed above. It is retained
because published claims cited it and because the disagreement between the
two runs is itself a finding. Sizes 10 and 50 were re-run after the first
pass flagged them self-skewed; only the re-runs are published — the
first-pass cell files were overwritten by the re-run and were not retained.

### The 59 seq gaps, root-caused

An earlier sweep recorded **59 `seqGaps`** on the `three-25` cell and zero
everywhere else. Chasing it found two separate defects — one in the metric,
one in the server — and it is worth writing down because the metric bug was
hiding the server bug.

**The metric counted reordering as loss.** The bot recorded a gap the moment
a timeline arrived with `seq > lastApplied + 1`, and nothing ever retracted
it when the skipped seq turned up a moment later. `isNewer` correctly drops
the late arrival, so the bot stayed converged the whole time — but the gap
counter had already fired. On one instance every broadcast originates from
one process in commit order, so this never triggered; the metric only broke
where deliveries could interleave.

Gaps are now decided at report time from the complete set of seqs a bot
received on an epoch: a gap is a seq **inside the observed range** that the
bot never received. Three outcomes, three counters, because `isNewer` is
false for all of them and lumping them together is what caused this:

| delivery | counter | what it means |
|---|---|---|
| a seq inside the range, never received | `seqGaps` | the only one that is a defect |
| a **lower** seq arriving after a higher one | `seqReorders` | out-of-order delivery; dropped by design |
| the **same** seq received twice | `seqDuplicates` | repeated delivery; idempotent to apply |

What this can and cannot see: the range is bounded by the lowest and highest
seq a bot actually received, so a loss *before* its first or *after* its last
is outside the rule and undetectable. `seqDuplicates` likewise records that a
seq arrived twice, not why — redundant repair is the expected source, but the
cause is not measured here. Re-running the failing cell against the same
server build:

| | seqGaps | reorders + duplicates |
|---|---|---|
| 3 instances, 25 bots (old metric) | 59 | not measured |
| 3 instances, 25 bots (fixed metric) | **0** | 97 |
| 1 instance, 25 bots (control) | 0 | 0 |

So no seq inside any bot's observed range went unreceived — which is what the
59 had claimed, and it was wrong. (That 97 was counted before reorders and
duplicates were split apart, so it is the sum of the two, not 97 genuine
reorders — the split landed while chasing this and is why the table above has
three rows.) But 97 is not noise, and the control run isolates the cause to
the multi-instance fanout.

**Every instance was sweeping every room it had a socket in.** The repair
sweep iterates `userRooms`, which is per-instance state, so with 25 bots
spread across 3 instances all three swept the *same* room every 10s:
`apply_snapshot.lua` bumped `seq` three times per period and fanned out three
snapshots for one repair. The cost scaled linearly with instance count — 10
instances would have meant 10× the snapshot writes and fanout for one room —
and the three racing commits were exactly what the clients then received out
of order.

The dedup belongs in the Lua script rather than in a lease, because Redis's
single-threaded execution already serializes these calls. `apply_snapshot`
buckets time into aligned windows of `SWEEP_DEDUP_PERIOD_MS`, records the
window it last committed in, and no-ops if it is called again in that same
window. The first caller of each window wins; if it dies, another wins the
next window, with no ownership to hand over.

**The dedup covers the commit, not the broadcast** — and that distinction is
the whole design. The first version suppressed the losing instances'
broadcast too, which quietly broke the failure model above: `server.to(room)`
delivers to an instance's own sockets *in-process*, so before the change
every instance repaired its local clients without touching pub/sub. Letting
only the winner broadcast would have made every other instance's clients
depend on the adapter — the exact channel whose failure the sweep exists to
repair. A losing instance now re-anchors its own sockets with
`server.local.to(room)`, which delivers in-process and publishes nothing, so
the repair path survives a pub/sub blip while the redundant writes and racing
seq bumps are still gone.

The window matters more than it looks. The first version of this guard tested
*elapsed time* against a threshold just under the period, which two
instances staggered by nearly a full period slip straight through: sweeps at
t=0 and t=9.5s both pass a 9s test, so a duplicate bump survives inside one
period. Raising the threshold to exactly the period instead risks suppressing
a lone instance whose timer fires a millisecond early. Aligned windows have
neither failure mode — at most one commit per window by construction, and a
10s timer always lands in a fresh one. `redis-room-state.store.spec.ts` pins
all of it against a real Redis: simultaneous callers, the staggered caller,
the next window still getting through, and a paused room never advancing.

Measured on the 3-instance lab, 25 bots, 120s:

| | commits in 120s | per 10s period | reorders | duplicates |
|---|---|---|---|---|
| 3 instances, before | 40 | 3.3 | 97 (conflated) | — |
| 3 instances, after | **14** | **1.2** | **0** | 170 |
| 1 instance (reference) | 14 | 1.2 | 0 | 0 |

The three-instance plane commits at exactly the single-instance rate:
coordination cost no longer scales with instance count. The 170 duplicates
are the design working — each instance re-anchoring its own clients with the
seq the winner committed, which `isNewer` discards and which is why
duplicates are counted apart from reorders rather than lumped in as noise.

The repair channel is verifiably still alive — 14 commits over 120s is the
~12 sweeps plus the scripted control events, not a wedged sweep. That was the
main risk of the change, so it was measured rather than assumed.

The full matrix was re-run on this build once the machine was quiet (§5,
"current matrix"): gaps and reorders are zero on all ten cells, and the
duplicate counts follow the designed local-re-anchor signature exactly. An
earlier refresh attempt at a 15-minute load average of 8.19 on 10 cores was
discarded unpublished — the harness's own validity gate (>0.7 load/core)
rejects it, and printing it would be exactly the sort of number this
document promises not to.

Worth noting against the A/B in [COORDINATION.md](COORDINATION.md): plane B
never had this bug. Its sweep is owner-only by construction (`only the owner
sweeps its rooms; non-owners no-op`), so explicit ownership had already ruled
out a class of redundancy the shared-store plane had to be patched to avoid.

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
