# Formal verification

The sync coordination protocol is model-checked with TLA+/TLC
([`formal/SyncTimeline.tla`](../formal/SyncTimeline.tla)). This is not
decoration: **the spec found a real protocol bug, rejected the obvious fix,
and forced the design that shipped.**

## What is modeled

The plane-A coordination protocol: one authoritative store (the Redis Lua
script is one atomic action), commits fanned out over a **lossy, reordering**
channel (pub/sub), clients applying timelines by an ordering rule, the 10s
snapshot sweep as the repair channel, and store loss (flush/restart)
rehydrating under a fresh `storeEpoch`.

Abstracted: media position (the spec is about *state distribution*, not
drift), real time (action ordering only), instance identity (the store
serializes all instances, so which instance committed is irrelevant).

Checked with TLC over 2 clients, seq ≤ 3, one flush — small constants, but
the violations below appear at depth 5, well inside the space.

## Finding 1 — "different epoch always wins" regresses clients

The rule as first implemented: same epoch → higher seq wins; different
epoch → accept (an epoch change means the store was rehydrated, so it "must"
be newer). TLC's counterexample: a pre-flush broadcast still in flight is
delivered **after** the post-flush one — pub/sub reorders — and drags the
client back onto the dead epoch until the next sweep repairs it (≤10s of
wrong state, per occurrence). `NoEpochRegression` violated at depth 5.

## Finding 2 — dead-epoch memory cannot fix it

The obvious repair: clients remember epochs they have abandoned and refuse
them. TLC rejects this too: the regression trace never *visits* the old
epoch — a client that joined after the flush receives the stale epoch-1
broadcast as an epoch it has **never seen**, and no amount of memory can
classify a never-seen epoch as fresh-or-stale. Staleness of unknown epochs
is undecidable without ordering.

## The fix — epochs are totally ordered

`storeEpoch` is now minted from the **store clock domain** at rehydration
(`redis.call('TIME')` in the Lua init; the local clock for the in-memory
store): higher epoch wins, same epoch → higher seq, anything else is
dropped. TLC proves the ordered rule satisfies every property:

| Property | naive | dead-epochs | **ordered** |
|---|---|---|---|
| `TypeOK` | ok | ok | ok |
| `NoSeqRegression` | ok | ok | ok |
| `NoEpochRegression` | **violated** | **violated** | ok |
| `Convergence` (liveness) | — | — | ok |

The implementation change is three lines in `shared/sync-core/timeline.ts`
(`isNewer`) plus the epoch mint in both stores; the TLC counterexample is a
unit test (`timeline.spec.ts`: "a STALE pre-flush broadcast is dropped").

## Fairness, honestly

Liveness needs *strong* fairness on delivery: with weak fairness, a
drop-everything schedule is "fair" (delivery keeps getting disabled by
drops), which would vacuously kill the repair channel in the model. Strong
fairness states exactly the real assumption: pub/sub may drop any message,
but a channel offered messages forever delivers infinitely often — lossy,
not dead.

## Reproduce

```bash
cd formal
java -cp tools/tla2tools.jar tlc2.TLC -config SyncTimeline_naive.cfg SyncTimeline.tla        # violation
java -cp tools/tla2tools.jar tlc2.TLC -config SyncTimeline_deadepochs.cfg SyncTimeline.tla   # violation
java -cp tools/tla2tools.jar tlc2.TLC -config SyncTimeline_ordered.cfg SyncTimeline.tla      # passes
```

The ordered config runs in CI nightly.

---

# Plane B: room-actor ownership with lease fencing

`formal/SyncActor.tla` specifies the M13 coordination design **before any
implementation exists** — the point of doing formal methods at all. One
room, N instances, ownership by a lease in the shared store; the owner
serializes control events in memory and commits under its fence; owner
crash expires the lease; any live instance may claim with a fresh higher
epoch; and a crashed-then-revived instance returns as a **zombie** still
believing it owns the room.

Modeled adversary: crash at any point, revive at any point, lossy and
reordering client fanout, claim races, and zombie commits under stale
fences.

| Property | result |
|---|---|
| `AtMostOneCurrentOwner` (≤1 instance holds the current fence) | ok |
| `NoStaleFenceWrite` (the store never accepts a zombie's commit) | ok |
| `CommitMonotone` (seq never regresses within an epoch) | ok |
| `ClientNoRegress` (ordered rule holds under ownership churn) | ok |
| `Convergence` (clients converge once commits cease — see caveat) | ok |
| `NoClientStrandedBehind` (per-FIXED-version client progress) | ok |
| `EveryForwardedControlProgresses` (no forwarded control starves) | ok |

The spec now also models the **forwarding path** the implementation ships:
a non-owner publishes the control to the room's owner and the owner
dequeues and commits it under its fence; if the observed owner is gone the
publish reaches nobody and the sender reclaims rather than dropping the
user's intent (the code's `PUBLISH`-returns-0 branch). Adding it took the
state space from ~50k to ~194k distinct states, and both safety and
liveness still hold.

Two further review rounds hardened it again. The progress property
`NoClientStrandedBehind` re-evaluated `committed` in its consequent, so it
only said "the client eventually catches whatever is current" — it now
quantifies over a **fixed version**, which is the per-version guarantee the
doc claims. Aggregate fairness over `\E m \in pending` also let one
forwarded control starve while others were repeatedly chosen; fairness is
now per control identity, and `EveryForwardedControlProgresses` checks that
every admitted control eventually leaves the queue.

Adding that property immediately failed — and the counterexample was a
**modelling artifact worth recording**: two direct commits exhausted
`MaxSeq`, after which an already-forwarded control could never commit and
sat in the queue forever. The bound was capping *writes* when it should cap
*inputs*. `MaxSeq` now limits how many controls ever ENTER the system
(local commits and forwards alike), which is what a bounded model of a
real system should mean. A write bound masquerading as control loss would
have been indistinguishable from a genuine bug.

A second review round had already caught the forwarding model **modelling
losses the implementation does not have**: `pending` held only `[to]`, so two
forwards to the same owner collapsed into one element, and a dequeue that
could not commit consumed the control anyway. Controls now carry an
identity, and a dequeue that cannot commit **re-targets** to the current
owner instead of swallowing it — which is what the code does. That change
took the state space to ~436k distinct; safety and liveness still held.

Converting `MaxSeq` from a write bound to an input bound then shrank it
again, since the budget is now shared between commits and forwards rather
than consumed only by writes. **Current figures, both green:**

| config | constants | states generated | distinct | depth |
|---|---|---|---|---|
| `SyncActor.cfg` (safety) | `MaxSeq=3`, `MaxEpoch=2`, `MaxCtl=2` | 621,993 | 85,940 | 19 |
| `SyncActor_live.cfg` (liveness) | `MaxSeq=2`, `MaxEpoch=2`, `MaxCtl=2` | 59,837 | 9,772 | 16 |

The safety config runs at `MaxSeq=3` precisely because the tighter input
bound freed the headroom to go deeper; liveness stays at 2, where the
fairness obligations remain tractable. Both are small — the point of
quoting them is to show the scale honestly, not to imply the unbounded
system was covered.

Four modeling lessons worth recording:

- **The sweep needs strong fairness here too.** With weak fairness, crash/
  revive churn keeps disabling the sweep and an adversarial scheduler
  starves the repair channel forever — a modeling artifact, not a real
  failure. SF states the actual assumption: an owner alive infinitely often
  sweeps infinitely often.
- **A model can be more pessimistic than the code, and that hides bugs too.**
  Collapsing two controls into one set element and dropping an uncommittable
  one made the spec describe a lossy system; had a real loss existed, the
  model would have looked "correct" for the wrong reason.
- **An invariant can be weaker than its name.** `NoStaleFenceWrite`
  originally required only that `committed.epoch` never DECREASE — which a
  stale write retaining the same epoch satisfies. It now requires every
  transition that changes `committed` to write under the *current* lease
  epoch, which is what the name always claimed.
- **Liveness checking needs bounded state.** The sweep's re-fanning makes
  the in-flight message powerset explode; a `NetworkBound` constraint (≤4
  in flight) plus small constants keeps TLC tractable. Both are checked at
  small constants, though **not identical** ones — safety at `MaxSeq=3`,
  liveness at `MaxSeq=2`, where the fairness obligations stay tractable —
  stated plainly rather than implying exhaustive coverage of the unbounded
  system.

**What the liveness result does and does not say.** `MaxSeq`/`MaxEpoch` make
commits finite, so `committed` must eventually stop changing: TLC verifies
that clients converge **once commits cease** — repair after the last write,
under the crash, revive, and message-loss behaviors this spec models.

Four qualifications, because "converges under crash and message loss" is a
much bigger claim than what was actually proven:

- **Bounded, not arbitrary.** Crashes, revivals, epochs, and controls are all
  capped by the constants (`MaxSeq`, `MaxEpoch`, `MaxCtl`); the result covers
  behaviors within those bounds, not every behavior of the real system.
- **Bounded network.** `NetworkBound` caps in-flight messages at 4. Loss is
  modeled; unbounded backlog is not.
- **Strong fairness is an assumption, not a proof.** The result holds only
  where a live owner sweeps and dequeues infinitely often. A partitioned or
  permanently-wedged owner is outside it.
- **Not verified for continuing traffic.** Convergence is checked after the
  last commit. A room under unbounded, continuing control traffic is a
  behavior this model cannot exhaust.

Stated here rather than left for a reader to infer from the constants.

**Design consequence:** epochs serve double duty — the fence that
neutralizes zombies *and* the client ordering rule proven above. One
mechanism, two guarantees, which is why plane B needs no new client-side
concept.

# Exactly-once command application

`formal/SyncExactlyOnce.tla` — the third spec, written **before** the
idempotency-key implementation it constrains, the same spec-first order as
plane B.

## What is modeled

Every control command carries a client-minted id. The client **retries** a
command until it observes the commit — which is at-least-once delivery, and
is deliberately how the model gets its duplicates: a socket.io send-buffer
flushing after a reconnect *is* a retry, whether or not anyone calls it that.
On top of that the channel can duplicate in-flight copies outright, and
delivery picks any pending command, so reordering needs no extra machinery.

The store's apply is **one atomic step** containing the dedup check, the
commit, the log append, and the dedup record — because in the implementation
all four live inside the same Lua script, and Redis's single-threaded
execution is what makes the composition atomic. Exactly-once is therefore
proven as a composition: at-least-once delivery (retry) with at-most-once
application (atomic dedup) — never as a property of the network.

**Time is concrete where it matters.** Dedup records expire a fixed `Ttl`
after the apply — a plain clock, exactly what `SET .. PX` gives the
implementation, with no oracle about in-flight copies. Sending, resending,
network duplication, and *delivery* are all bounded by `RetryWindow` after
first issue: past the client's retry deadline nothing carries the command
any more. That bound is an **assumption the implementation must enforce** —
the client abandons unacked commands older than the window instead of
letting an arbitrarily old send-buffer flush — and it is what makes any
finite TTL sound: with an unbounded retry window, no TTL is safe, and the
spec would say so.

## Properties and teeth

| config | constants | result |
|---|---|---|
| `SyncExactlyOnce.cfg` (safety) | `Ttl=2 > RetryWindow=1`, eviction reachable | **green**: `TypeOK`, `AtMostOnce`, `TransitionContract`, `ReplayReconstructs`, `AckedWasApplied` — 1,559,644 states, 628,684 distinct |
| `SyncExactlyOnce_live.cfg` (liveness) | window spans the model clock | **green**: `EventuallyExactlyOnce` — 371,055 states, 144,147 distinct |
| `SyncExactlyOnce_nodedup.cfg` | `DedupOn = FALSE` | **must fail** `AtMostOnce`: a retried command applies twice |
| `SyncExactlyOnce_earlyevict.cfg` | `Ttl=1 <= RetryWindow=2` | **must fail** `AtMostOnce`: the record expires while a copy can still arrive and the late duplicate re-applies |
| `SyncExactlyOnce_nosnaplog.cfg` | `LogSnapshots = FALSE` | **must fail** `ReplayReconstructs`: unlogged sweep commits leave the log unable to rebuild live state |

Liveness lives in its own config because a retry window that closes
mid-model legitimately *abandons* an unacked command — at-most-once by
design, not a stuck system — so "eventually applied exactly once" is only a
theorem while the client is still trying.

The three failure configs are the spec keeping its teeth, and each pins a
real implementation constraint:

1. **The dedup must be atomic with the commit** — a check outside the Lua
   script reintroduces the race the guard exists to close.
2. **The dedup TTL is a correctness parameter, not a tuning knob.** The
   relation is modeled with concrete clocks: `Ttl > RetryWindow` is checked
   green, and `Ttl <= RetryWindow` is a committed counterexample (apply at
   t, record expires at t+`Ttl`, duplicate arrives inside the still-open
   window). "SET NX with some TTL" is not a design until the TTL is
   justified against the enforced retry deadline — and the deadline must be
   enforced: the client abandons unacked commands older than the window.
3. **The command log must include the repair sweep's snapshot commits.**
   Sweeps bump `seq` and re-anchor the projection; a log of user commands
   alone cannot replay to live state, so reconciliation built on it would
   report phantom drift.

`TransitionContract` is double-entry bookkeeping: the legal-transition
contract (a seek never flips play state; a pause freezes at the commanded
frame, not the projection; a snapshot moves the projection by exactly
nothing; `seq` increments by exactly one) is written independently of the
`Apply`/`Snap` definitions, so if either side drifts, TLC reports the
disagreement rather than trusting the model's own construction.

## Composition with the other specs

This spec is single-epoch and single-store on purpose: `SyncActor.tla` owns
instance fencing and lease handoff, `SyncTimeline.tla` owns client-side
`(storeEpoch, seq)` ordering under lossy fanout. The seam between them is a
real implementation obligation this spec makes visible rather than proves:
**the dedup record must survive owner handoff** on the actor plane, or a
command applied by the old owner can be re-applied by the new one. That
lives with the fencing machinery, and is called out in COORDINATION.md
rather than silently assumed here.
