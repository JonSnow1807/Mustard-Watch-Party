# Baseline measurements — the engine as shipped

Measured before any sync work, with a read-only telemetry shim as the only
frontend change (published in the same branch; see `sync-harness/README.md`
for methodology). Three real Chrome clients, Big Buck Bunny, deterministic
240s scenario: staggered joins → play@30s → seek@90s → pause/resume@150/155s
→ hands-off. Every number below traces to a committed run directory with SHA,
scenario, and hardware in `meta.json` — with one exception, called out
explicitly in the table below rather than quietly folded in.

## Headline: the shipped sync works only on localhost

| Scenario | Result | Artifact |
|----------|--------|----------|
| S0 clean loopback | P50 pairwise drift **363ms**, P95 **255.3s**, no control event ever converged | `S0-baseline-mscjatn1/` |
| S2 +150ms each way | **Total failure** — the host plays; followers never start | `S2-baseline-mscjtbgk/` (exhibit) |
| S3 jitter / S5 loss / S6 asym | Aborted before measurement: the player-health gate FAILED both attempts, the same signature as S2 (followers never started) | **none** — the run aborts before writing a directory |

The S3/S5/S6 row is an observation, not a measurement. The harness retries a
run whose players fail the health check and then aborts it, so nothing was
written and there is nothing to cite (S2 exists only because it was re-run
with `HARNESS_ALLOW_UNHEALTHY=1`, which captures a failing run as a labeled
exhibit instead of discarding it); `compare.ts`, which reads only committed directories,
correctly reports those scenarios as "not measured". They are listed here
because what happened is informative, and omitted from any published number
because an uncommitted observation is not evidence. The overhaul's numbers
for S3/S5/S6 therefore stand without a paired before-figure.

## Finding 1 — control events are silently lost on any real network

The player's `onStateChange` handler is registered once at player init and
captures `broadcastState` from that render. `broadcastState` no-ops unless
`connected` was already true **at component mount**. On loopback the socket
wins the race against the room fetch, so dev testing never sees the bug; add
~100ms of connection latency (any proxy, any WAN) and the closure is frozen
with `connected=false` — **every play/pause/seek broadcast is dropped
forever**, with no error anywhere. Server logs across all impaired runs show
joins but not a single `video-state` event.

Exhibit: `S2-baseline-*/charts/playhead-timeseries.svg` — the host's playhead
climbs for 200s while both followers flatline at 0. Pairwise drift is
reported as NaN because sync never began: there is nothing to pair.

## Finding 2 — a host seek permanently desyncs the room by the seek distance

`handleProgressClick` calls `seekTo(target)` and then broadcasts
`getCurrentTime()` — which still returns the **pre-seek** position. Followers
"seek" to where the host already was; the host jumps ahead by the full seek
distance. In S0, the scripted seek (+255.3s) put the host exactly 255.27s
ahead of both followers **for the remaining 150s of the run** (P95/P99/max in
`S0-baseline-*/stats.json`). Nothing ever corrects it:

## Finding 3 — there is no correction mechanism at all

The server's `sync-check` handler (3-second threshold) is dead code — the
live client never emits it. The only periodic traffic is a ping/pong badge.
Once clients diverge — a late join, a missed event, finding 2 — divergence is
permanent. No control event in any run ever converged to <150ms sustained
(`convergenceAfterEventsS` is `null` across the board).

## Finding 4 — even the working case is ragged

S0 steady-state P50 of **363ms** reflects raw play-start spread: followers
receive `play` one hop later and spin up their players at different speeds,
and nothing trims the residue. `getCurrentTime` readout quantization
(noise-floor histogram, plateau P50/P95 in `stats.json`) sets the floor any
future controller must respect — the overhaul's deadband derives from this
measured value, not a guess.

## Also found while building the harness

Deep links (`/room/<code>`) served a blank page from any static host —
CRA's `homepage: "."` emitted relative asset paths, so the SPA fallback
answered asset requests with HTML. Fixed in this branch (it blocked the
harness itself); noted here because it means **shared room links, the
product's core loop, were broken in production builds**.

## What this baseline commits the overhaul to

1. Control propagation that cannot lose events to connection races
   (server-authoritative timeline, wait-for-broadcast semantics).
2. Seeks that broadcast intent, not a stale readout.
3. Continuous drift correction with a measured deadband (≥ the quantization
   floor) and honest convergence targets per network scenario.
4. Re-measurement with this same harness, same scenarios, same hardware —
   before/after on equal terms.
