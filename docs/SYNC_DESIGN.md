# Sync Design

How Mustard Watch Party keeps N YouTube players on different networks at the
same frame, and how we know it works. Every number in this document traces to
a committed run directory under `docs/measurements/` (SHA, scenario, hardware
in `meta.json`); the harness and methodology live in `sync-harness/`.

## 1. Problem and goals

A watch party is distributed clock synchronization under variable network
conditions: N clients with unsynchronized clocks and heterogeneous latency
must agree on "what frame is now." The measured baseline of the app as
originally shipped (`docs/measurements/baseline/`) frames the problem
honestly: control events silently lost on any real network, a host seek that
desynced the room by the full seek distance permanently, and no correction
mechanism at all — **the shipped sync worked only on localhost**.

Goals, as measured targets rather than adjectives: steady-state pairwise
drift P95 ≤ 150ms on clean and high-latency symmetric paths; convergence
after any control event ≤ 2.5s median; zero visible correction jumps in
steady state; graceful degradation (never divergence) under jitter and loss.

## 2. System model: whose clock is truth

The room's state is a **projectable function, not a scalar**:

```
Timeline = { seq, storeEpoch, videoId, isPlaying, mediaTime, stampedAt, rate=1 }
mediaTimeAt(serverNow) = mediaTime + (isPlaying ? (serverNow − stampedAt)/1000 · rate : 0)
```

The server is the sole authority. Control intents (`play`/`pause`/`seek`)
are restamped server-side and broadcast as a new Timeline with a
monotonically increasing `seq`; clients drop anything older than the last
applied `(storeEpoch, seq)`. The commander is just another follower —
**wait-for-broadcast**: nobody, including the button-presser, touches their
player until the restamped timeline returns. This costs one RTT of button
latency and buys structural impossibility of echo storms (the baseline's
collaborative-mode failure mode) plus identical convergence for everyone.

With Redis (the multi-instance plane), timestamps come from `redis.call
('TIME')` **inside the store's Lua scripts**, and each instance converts its
own stamps through a smoothed local→Redis offset — one clock domain, so
inter-instance wall-clock skew cannot masquerade as playback drift (measured
ack-offset spread across 3 live instances: **4ms**).

## 3. Clock sync

NTP-style over a Socket.IO ack: client stamps t0/t3, the server ack carries
t1/t2 (stamped with zero awaits).

```
θ = ((t1−t0) + (t2−t3)) / 2        rtt δ = (t3−t0) − (t2−t1)
|θ_true − θ| ≤ δ/2 + |path asymmetry|/2
```

The asymmetry term is irreducible for any NTP-family scheme — scenario S6
(120ms up / 20ms down) exists to demonstrate the bias honestly rather than
hide it. Estimator: ring of 64 samples; θ̂ = median of the 5 lowest-δ samples
within 60s, tie-broken by recency (so a genuine server-clock change beats
stale equal-quality history); corrections under 20ms slew at ≤5ms/s so the
drift controller never sees its clock step, larger ones step immediately.
Cadence: 8×150ms burst on connect/reconnect/visibility-restore, then 1/2s;
suspended while the tab is hidden (throttled timers produce garbage samples).
Validation: bot fleets with injected ±1s offsets and ±80ppm skews recover
ground truth to **θ-error P95 ≈ 2ms**.

## 4. Drift correction

Each client runs a 4Hz loop: `drift = playerTime − mediaTimeAt(serverNow)`,
where `playerTime` is de-quantized by timestamping 20Hz `getCurrentTime()`
value-change edges and extrapolating between them (the raw readout is steppy;
its measured plateau distribution is in the baseline run).

**SEEK-first, by evidence:** the IFrame API rounds unsupported playback rates
toward 1, so fractional-rate nudging cannot be the design center. A per-video
runtime probe (`setPlaybackRate(1.05)`, read back what stuck, restore) gates
a RATE mode used only where supported; a probe that lies self-corrects when
the applied rate is observed.

The controller is a pure state machine (LOCKED / NUDGING / SEEKING /
BUFFERING / PAUSED_SYNC / SUSPENDED), shared verbatim between the browser,
the bot fleet, and jest. Key mechanics, each traceable to a measured failure:

- **Corrective seeks target `projected + lead`**, where the lead is an EMA
  learned from each seek's settle residual. A missed seek (landed out of the
  deadband) adapts the lead and corrects again — geometric convergence.
- **Post-seek settle stays part of the seek.** Letting the BUFFERING state
  swallow it orphaned the residual and parked the whole bot fleet ~200ms
  behind, tolerated forever.
- **A commanded play is itself a correction**: starts land late by the
  command latency (a ~275ms mode across the fleet), so `play` enters SEEKING
  and the landing error is measured and corrected like any other seek.
- Deadband ±120ms (≥ the measured readout noise); seek threshold 150ms
  sustained 2 evals; instant path >2.5s (post-tab-sleep); 3s anti-storm
  spacing; buffering = free-run then catch-up (P2); hidden tab = suspend,
  immediate re-evaluation on restore.

## 5. Policy decisions (and rejected alternatives)

- **P1 mid-join**: joiners receive the projected timeline inside
  `room-joined` and converge through the normal controller path (play →
  buffer → catch-up seek with lead) — zero special-case code.
- **P2 buffering**: free-run + catch-up. The room never stalls for one bad
  connection; the stall-room alternative punishes N−1 viewers and was
  rejected (acceptable at 2 viewers, terrible at 10).
- **P3 host disconnect**: the timeline runs on (server arithmetic needs no
  client); the longest-connected participant is promoted controller and the
  creator reclaims on return — the shipped app left such rooms permanently
  uncontrollable.
- **P4 pause position**: the commander's frozen frame wins. Projecting
  forward would pause at a frame the presser never saw.
- **P5 restart**: rehydrate from Postgres **paused** with a fresh
  `storeEpoch` — a stale epoch must not fast-forward a room, and a fresh
  epoch can never strand clients at a high stale seq.

## 6. Protocol

Five events: `sync:clock` (ack: `{t0}`→`{t0,t1,t2}`), `sync:control`
(`{roomCode, intent, mediaTime}`; identity comes only from the JWT-verified
socket), `sync:timeline` (the only state message), `sync:control-rejected`
(`not-controller` / `rate-limited` / `room-not-found`), `room:controller`
(succession/reclaim). A 10s server sweep re-anchors playing rooms as the
repair channel for lost broadcasts; redundancy is harmless because clients
order by `(storeEpoch, seq)`.

## 7. Measurement methodology

Two tiers, one contract. **Real-browser runs**: 3 Chrome instances driven
through a deterministic 240s scenario; the app exposes a read-only telemetry
ring the harness polls, and all browsers share the host clock, so pairwise
numbers never depend on the app's own clock sync — the instrument does not
grade itself. **Bot fleets**: the identical shared estimator/controller
against simulated players with seeded imperfections, for scale and CI.
Impairment: Toxiproxy for per-direction latency/jitter (incl. asymmetric);
an nginx-stream proxy container with `tc netem` inside for true packet loss
(one root qdisc impairs both legs: `delay X` ⇒ +2X RTT, stated per scenario).
YouTube CDN traffic never crosses a proxy. Steady-state windows exclude 15s
warmup and 5s after control events; all-time numbers are also reported.
Runs are health-gated; total failures are recorded as labeled exhibits, not
discarded. CI runs a 10-bot tripwire on every push (P95 < 250ms, bounded
growth, seq integrity) — deliberately loose for shared runners; headline
numbers come from local, hardware-documented runs.

## 8. Results

See `docs/measurements/` for the run directories behind every number.

| Metric (S0 clean, 3 browsers) | baseline | overhauled |
|---|---|---|
| pairwise drift P50 | 363ms | **33ms** |
| pairwise drift P95 | 255.3s | **102ms** |
| convergence after play / seek | never | **1.5s / 0.75s** |
| hard seeks per minute (steady) | — | **0** |

<!-- RESULTS-MATRIX: full impaired matrix inserted by the M7 measurement pass -->

Protocol-level (bot fleet, local): 10 bots × 150s — P50 71ms / P95 112ms /
P99 195ms, growth +5.6ms/min (bounded); 100 bots, one room, one instance —
P50 77ms / P95 170ms. Multi-instance: see `docs/SCALING.md` for the
1-vs-3-instance comparison, the knee, and its attribution.

## 9. Known limitations

- **Ads/interstitials**: the embedded player can be interrupted by content
  we cannot observe; repeated refused plays surface a click-to-resume chip
  instead of fighting. A production sync product ultimately needs an owned
  player for controllable content.
- **Path asymmetry** biases θ by asym/2 — measured and displayed (S6), not
  correctable by any NTP-family scheme.
- **Background tabs** are suspended, not synced; they resync on focus.
- Tokens are verified at connect only; REST room mutation still trusts the
  body; voice rosters are per-instance (the voice mesh is not the sync
  plane). Each is a deliberate scope cut, documented rather than hidden.

## 10. Future work

Predictive clock-discipline control (RLS skew estimation + PI servo) where
fractional rates permit; signal-truth validation via per-client audio capture
and cross-correlation; a formally specified (TLA+) coordination protocol with
a second (Go) implementation; single-owner room actors with lease fencing as
the scale-out endgame. These are the M9–M13 tracks of this repo's plan.
