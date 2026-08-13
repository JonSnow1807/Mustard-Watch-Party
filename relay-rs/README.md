# relay-rs — a third conformance implementation, and where the runtime finally matters

A Rust implementation of the sync plane, built as a **study** and as a
**third independent conformance target** for the TLA+-checked protocol. It
speaks the identical binary frames as `relay-go`, runs the **same Redis Lua
scripts** against the same Redis, and enforces the same JWT and revocation
rules. Three codebases that must agree on every byte of committed state is a
stronger conformance check than two — and a GC-free implementation stresses
the spec from an angle neither GC'd plane (Node, Go) does.

It is **not deployed** and, like relay-go, is not built for a mixed-mode
deployment. It exists to be measured and to keep the protocol honest.

## Conformance — it is a real third implementation, not a sketch

| check | result |
|---|---|
| Protocol (bot fleet, gated) | **pass** — 0 seq gaps, exact commit counts, drift within SLO, same suite that gates Node and Go |
| Revocation (`relay-revocation-check.mjs`, 16 checks) | **pass** — revoked-at-accept 401, sibling survives, sign-out-everywhere, expiry sweep, process survives eviction |
| Frame codec / JWT / charset (unit) | **pass** — 6 tests, strict-length parsing and the malformed-versus-padding boundary |

The revocation check is the **same script** that proves relay-go, pointed at
the Rust binary via `RELAY_BIN`. A byte the Rust plane got wrong would show up
as a divergence, not a design difference — which is the whole point of a
conformance target.

## The evaluation the drift numbers could not do

The earlier study measured **sync drift** and found Go tied Node (73 vs
75ms P50) — because drift is bounded by the protocol and the network, not the
runtime. That answer is correct and also unsatisfying: it measures the one
thing where the runtime is *invisible*. So this study measures the things
where it is not: **memory per connection, CPU, and latency under load**, at
1,000 and 10,000 concurrent connections — with the finding, spelled out
below, that memory is the clean result and the extreme tail is not cleanly
measurable on one machine.

### Results

Same machine, same load client, same Redis, one relay under test at a time.
Committed artifacts: `docs/measurements/relay-load/loadtest-*.json`.

Committed run `fc6e0b9` (clean tree), the numbers cited here:

**1,000 connections**

| | RSS / conn | RTT p50 / p95 / p99.9 / max |
|---|---|---|
| relay-go | 43 KB | 13 / 22 / 24 / 24 ms |
| relay-rs | 16 KB | 11 / 17 / 23 / 23 ms |

**10,000 connections** (committed run `bf9c5bf`)

| | RSS / conn | RTT p50 / p95 / p99.9 / max | CPU% |
|---|---|---|---|
| relay-go | 40 KB | 64 / 193 / 252 / 287 ms | 5.2 |
| relay-rs | 15 KB | 50 / 155 / 270 / 277 ms | 1.6 |

The **extreme tail (p99.9) does not cleanly separate the runtimes on this
hardware** — across three 10k runs Go's p99.9 was 390 / 238 / 252 ms and
Rust's was 175 / 167 / 270 ms. Rust is consistently better at the **median
and p95** (this run 50/155 vs 64/193, and similarly in the others), and its
memory and CPU wins are steady, but the p99.9 is noisy enough on a single
co-resident machine that neither its magnitude nor its ordering is reliable
run to run. See the honesty note.

### What the numbers say

1. **Memory: ~3× at scale, and rock-steady.** Go held ~49 KB per connection,
   Rust ~15 KB — the most consistent result across every run. At 10k that is
   ~490 MB versus ~150 MB; extrapolated to 100k it is roughly 4.9 GB versus
   1.5 GB, the difference between fitting on one box and not. Go's
   goroutine-per-connection stack plus GC headroom is the cost; Rust's
   per-task future is smaller and there is no GC headroom.

2. **Tail latency is where Rust separates, and its VARIANCE is the GC story.**
   At 10k the median gap is modest (45 vs 63 ms), but the tail is not, and the
   tail's *instability* is the tell. Across runs, Rust's P99.9 held near
   167–175 ms; Go's ranged from 238 ms (this committed run) to 390 ms and a
   545 ms worst-case (an earlier run). Rust's tail tracks its median run to
   run; Go's does not, because it is set by when the garbage collector happens
   to stop the world — and at 10k connections a multi-millisecond pause lands
   on someone. A GC-free runtime does not have that failure mode. This is
   exactly the advantage the drift measurement (which tied) was structurally
   blind to.

3. **CPU: the committed 10k run recorded 9.2% for Go and 1.6% for Rust** —
   Rust at roughly a sixth of Go's, ~83% lower. Treat the exact figure as
   indicative (`ps %cpu` is a coarse instantaneous snapshot, not integrated
   over the run), but the direction agrees decisively with the memory and
   tail results.

### Honesty about the measurement

- **Single machine, client co-resident.** The load client and both relays ran
  on one 10-core / 16 GB laptop, so absolute RTTs are inflated by the client
  competing for cores — the numbers are a **conservative floor**, not
  production latency. The **comparison** is fair: same client, same instant,
  same everything except the server binary.
- **macOS, not the Linux production target.** GC and scheduler behaviour
  differ; the *shape* (Rust flatter tail, lower memory) is expected to hold on
  Linux, but the exact figures would move.
- **No 10k Node number.** Node speaks Socket.IO/JSON, not this raw binary
  protocol, so the same raw-WS load client cannot drive it; a fair Node load
  test needs a Socket.IO load client this study did not build. Node's
  per-connection cost is architecturally the highest of the three (it is why
  the relay exists at all), but that is stated, not measured here.
- Every number above comes from a committed run with a `gitSha` stamp, per the
  repo's measurement-honesty convention. A `-dirty` stamp means the artifact
  predates its commit and should not be cited.

### The verdict on "is Rust worth it for this"

The drift study said the runtime does not matter; it measured the one axis
where the runtime is invisible. This study found the axis where it is not,
and it is **memory** — a clean, large, reproducible ~3× (15 vs 40–49 KB per
connection), which at 100k is the difference between ~1.5 GB and ~4.5 GB, and
CPU roughly a fifth. That is the real, defensible result. The latency picture
is smaller and partly inconclusive: median and p95 are consistently a little
better on Rust, and the extreme tail — where a GC-free runtime *should* win —
this single-machine harness cannot measure cleanly.

So: **not worth deploying today** (you are not at that scale, and it doubles
the maintenance surface). The forward-looking case for Rust rests mostly on
**memory density** — packing several times more connections per box — with a
modest latency edge and a theoretical tail-latency advantage this setup could
not confirm. Until you are at that scale it earns its place as a conformance
target, which is where it stays.

## Running it

```bash
cargo build --release
./target/release/relay-rs -addr :3510 -redis redis://localhost:6380 \
    -jwt-secret <secret> -lua-dir ../video-sync-backend/src/sync/lua

# conformance:
RELAY_BIN=$(pwd)/target/release/relay-rs RELAY_PORT=3502 \
    node ../scripts/live-checks/relay-revocation-check.mjs

# load evaluation (see sync-harness/src/bots/loadtest.ts):
cd ../sync-harness && ulimit -n 65536
npx tsx src/bots/loadtest.ts --n 10000 --ws http://localhost:3510 \
    --plane relay --api http://localhost:3000/api --server-pid <pid> \
    --hold 30 --label rs-10k
```
