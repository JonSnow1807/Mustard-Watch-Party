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

The spec now also models the **forwarding path** the implementation ships:
a non-owner publishes the control to the room's owner and the owner
dequeues and commits it under its fence; if the observed owner is gone the
publish reaches nobody and the sender reclaims rather than dropping the
user's intent (the code's `PUBLISH`-returns-0 branch). Adding it took the
state space from ~50k to ~194k distinct states, and both safety and
liveness still hold.

Three modeling lessons worth recording:

- **The sweep needs strong fairness here too.** With weak fairness, crash/
  revive churn keeps disabling the sweep and an adversarial scheduler
  starves the repair channel forever — a modeling artifact, not a real
  failure. SF states the actual assumption: an owner alive infinitely often
  sweeps infinitely often.
- **An invariant can be weaker than its name.** `NoStaleFenceWrite`
  originally required only that `committed.epoch` never DECREASE — which a
  stale write retaining the same epoch satisfies. It now requires every
  transition that changes `committed` to write under the *current* lease
  epoch, which is what the name always claimed.
- **Liveness checking needs bounded state.** The sweep's re-fanning makes
  the in-flight message powerset explode; a `NetworkBound` constraint (≤4
  in flight) plus small constants keeps TLC tractable. Safety and liveness
  are checked at the same (small) constants — stated plainly rather than
  implying exhaustive coverage of the unbounded system.

**What the liveness result does and does not say.** `MaxSeq`/`MaxEpoch` make
commits finite, so `committed` must eventually stop changing: TLC verifies
that clients converge **once commits cease** — repair after the last write,
under arbitrary crash/revive and message loss. It does *not* verify
convergence for a room under unbounded, continuing control traffic, which
this model cannot exhaust. Stated here rather than left for a reader to
infer from the constants.

**Design consequence:** epochs serve double duty — the fence that
neutralizes zombies *and* the client ordering rule proven above. One
mechanism, two guarantees, which is why plane B needs no new client-side
concept.
