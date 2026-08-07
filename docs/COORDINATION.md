# Coordination planes: shared-store vs room actors

Two ways to keep N server instances agreeing on one room's timeline, both
implemented, both model-checked, measured head to head. `STORE_MODE`
selects: `lua` (default) or `actor`.

## Plane A — shared store, Lua-serialized (`STORE_MODE=lua`)

The room timeline is a Redis hash; every mutation is one Lua script
(read → validate → `seq+1` → HSET → return committed state). Redis's
single-threaded script execution *is* the serializer: concurrent control
events from different instances commit as `(seq n, n+1)` with no locks and
no ownership concept. Verified in `formal/SyncTimeline.tla`.

## Plane B — single-owner room actors with lease fencing (`STORE_MODE=actor`)

One instance owns a room under a lease; the owner holds the timeline **in
memory**, serializes control events locally, and commits under its **fence**
(the lease epoch). Non-owners never touch state — they forward the intent
over pub/sub and the owner commits and broadcasts. Lease expiry lets any
instance claim with a fresh, higher fence; a revived instance that still
believes it owns the room is a **zombie**, and its commit is rejected by the
Lua fence check.

Specified **before implementation** in `formal/SyncActor.tla` and verified by
TLC: at most one current owner, no stale-fence write accepted, commit
monotonicity, client no-regress under ownership churn, and convergence
despite crash/revive ([docs/FORMAL.md](FORMAL.md)).

Epochs do double duty: the zombie fence **is** the client ordering rule from
plane A, so plane B needs no new client-side concept.

## The A/B

25 bots, one room, 120s, identical scripted control events, same machine,
same Redis, single instance per arm. **[lab]** — both arms were measured
locally and the run outputs were not committed, so these figures are
reproducible from the harness but you cannot open the artifact behind them.
The drift rows come from the two 25-bot fleet runs; the handler means from a
`/metrics` scrape taken during each arm.

| | plane A (lua) | plane B (actor) |
|---|---|---|
| client drift P50 | 66.4ms | 65.5ms |
| client drift P95 | 119.1ms | 119.8ms |
| client drift P99 | 265.0ms | 264.2ms |
| seq gaps | 0 | 0 |
| server control handler, mean | **4.2ms** | **7.2ms** |

**Honest conclusion: at this scale the actor plane costs more than it
saves.** Client-visible sync quality is statistically indistinguishable —
coordination is sub-millisecond either way, which is noise against the 250ms
control loop and the network RTTs that actually bound drift. Server-side, the
actor plane is *slower* per control, because a first control on a room pays a
lease claim before its commit, where plane A pays one script call. (Small
sample: 4 control events per arm; the direction is clear, the magnitude is
not.)

**What the measurement cannot show** is where plane B actually pays: room
locality (an owner's in-memory timeline needs no store read), blast radius (a
Redis stall stops every room in plane A), and the scale-out shape — rooms
shard across instances instead of funnelling through one Redis. None of that
appears in a single-instance, one-room, 25-client test. Plane A remains the
default because it is simpler and, *by measurement*, not worse for this
product's shape.

**One point for plane B that the A/B missed entirely.** The A/B ran one
instance per arm, so it could not see that plane A's repair sweep was
redundant across instances: every instance holding a socket in a room swept
that room, committing and fanning out N times per period for one repair (see
[SCALING.md](SCALING.md#the-59-seq-gaps-root-caused) — 3.3 commits per period
on 3 instances, against 1.2 after the fix). Plane B never had this bug,
because its sweep is owner-only by construction — `only the owner sweeps its
rooms; non-owners no-op` falls straight out of having an owner at all.

That does not overturn the conclusion above: plane A was patched with a
guard inside the script it already had, and the actor plane's per-control
cost still stands. But it is a concrete instance of the thing the "cannot
show" paragraph was gesturing at — explicit ownership rules out whole
classes of duplicated work that a shared-store plane has to notice and
patch one at a time. Recorded because the A/B's conclusion would otherwise
read as more settled than one single-instance test can make it.

## Idempotency across handoff

The exactly-once work (SYNC_DESIGN §2a) has one plane-B-specific obligation:
the dedup record must survive an owner change. seq restarts when the fence
advances, so `(epoch, seq)` cannot identify a command across handoff — the
`cmdId` record can, because it is keyed fence-independently and lives in
Redis rather than owner memory. The check sits inside `actor_commit.lua`'s
fenced atomic step, and a duplicate is answered with current state rather
than `false` — `false` means fenced-out, and the caller drops ownership on
it. A command applied by the old owner, redelivered to the new owner via
the (redeliverable) forward channel, is answered as a duplicate; the spec
test pins it.

## Two bugs the implementation surfaced

1. **Non-atomic init.** 25 concurrent joins each passed a "no state yet"
   check and each committed a seq, so joiners recorded phantom gaps. Fixed
   by moving create-if-absent *inside* the fenced Lua script — the same
   atomicity plane A always had.
2. **Publish-before-commit.** The in-memory authority was seeded before the
   store accepted it, exposing a seq the room never broadcast. The actor now
   publishes ownership only after an accepted commit.

## A measurement trap worth recording

Three "actor plane" runs were served by a **stale backend**: `pkill -f "node
dist/main"` did not kill the npm-wrapped process, the new one failed to bind
with `EADDRINUSE`, and the harness happily measured the old one. The runs
looked plausible — sensible drift, alarming seq gaps — and were entirely
meaningless. The gaps only vanished once the port owner was killed by PID.

The lesson is in the runbook now: **prove which build answered, by binding
the check to the process that served the run.** Both signals below are
emitted by the responding instance itself, so a stale process cannot fake
them:

```bash
# 1. the PID listening on :3000 must be the one you just started
lsof -nP -iTCP:3000 -sTCP:LISTEN
# 2. the responding instance names itself. NOTE: instance_id is an env var,
#    so it identifies the PROCESS, not the build - set it per launch (e.g.
#    INSTANCE_ID=$MODE-$(git rev-parse --short HEAD)) if you need both.
curl -s localhost:3000/metrics | grep -m1 instance_id
docker exec <redis> redis-cli --scan --pattern 'room:*:lease'   # mid-run
```

A start script that does not fail loudly on `EADDRINUSE` will hand you a
measurement of the wrong build; `npm run start:prod` under `&` does exactly
that, which is how this happened.
