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

**Two controllers, one probe.** The IFrame API reference says unsupported
playback rates are rounded toward 1 — but the runtime probe measured the
modern player *accepting* fractional rates on real videos, so the engine
defaults to the **predictive servo** (§4a) and falls back to the SEEK-first
controller wherever the probe fails. The fallback matters: the reference's
rounding language is still true for live streams and some videos. A per-video
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

### 4a. Predictive clock discipline (the default)

`r = 1 − Kp·drift − Ki·∫drift − b̂`, where `b̂` is the player's intrinsic
drift rate at r=1, estimated by scalar RLS with exponential forgetting from
rate-corrected drift deltas. Anti-windup freezes the integral while the
command is clamped to [0.95, 1.05]; 0.5% command hysteresis stops player
churn; the SEEK-first controller retains lifecycle handling, gross errors
and the seek machinery, with its threshold moved to the servo-zone boundary
so the servo owns [deadband, 600ms].

The servo measures better in **every** real-browser scenario (table in §8),
most dramatically under packet loss (S5: P95 29ms vs 97ms) — it holds the
error near zero continuously instead of letting it grow to a correction
threshold and then seeking.

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

| scenario (one-way impairment) | baseline | reactive | **predictive servo (default)** |
|---|---|---|---|
| S0 — clean loopback | 363ms / 255.3s | 31 / 83ms | **16 / 49ms** |
| S2 — +150ms each way (~300ms RTT) | total failure | 25 / 139ms | **19 / 48ms** |
| S3 — 50±30ms jitter each way | total failure | 68 / 118ms | **23 / 79ms** |
| S5 — 25ms + 5% packet loss | total failure | 60 / 97ms | **11 / 29ms** |
| S6 — asymmetric 120/20ms | total failure | 47 / 120ms | **10 / 86ms** |

*Steady-state pairwise drift P50 / P95, 3 real Chrome clients, deterministic
240s scenario, identical hardware. "Total failure" = the shipped engine's
followers never started playing at all. Runs:
[`docs/measurements/`](docs/measurements/) — baseline, after (reactive),
servo (predictive).*

No control event in any baseline run ever converged; every overhauled run
converges after every event (seek ≤1s across the matrix, table above).
Asymmetry bias (S6): clients' θ̂ shows **+50.5ms vs the +50.0ms prediction**
(asym/2), symmetric control 0.0ms — the NTP-family floor made visible.
Earlier same-day runs under a loaded machine (idle lab containers + a
mid-run Redis restart) measured 2–4× worse tails and were superseded by
these controlled re-runs; both sets exist in history, and conditions are
recorded per run.

Protocol-level (bot fleet, local, reactive controller): 10 bots × 150s —
P50 74ms / P95 113ms / P99 255ms, growth +1.7ms/min (bounded); 100 bots, one
room, one instance — P50 68ms / P95 147ms, growth −1.3ms/min, zero seq gaps.
With the predictive servo (M9) the same 10-bot cell reports P50 **7.3ms** /
P95 83ms — the servo cancels steady-state drift outright, and transients
(joins, seeks, stalls) set the shared P99.

> **Protocol-level numbers were re-measured on 2026-08-04.** A defect in the
> bot fleet's simulated player (it discarded up to one 250ms tick of playback
> per drain/stall event) had *inflated* every protocol-level drift figure.
> The figures below are post-fix. **Real-browser measurements are unaffected**
> - those drive actual YouTube players, not the simulator - so the before/after
> matrix above is unchanged.
 Multi-instance: see `docs/SCALING.md` for the
1-vs-3-instance comparison, the knee, and its attribution.

### 8a. Validated against physical output

Player-API drift is self-reported. An independent track ([AUDIO_TRUTH.md](
AUDIO_TRUTH.md)) times the actual audio: **P50 13.2ms / P95 64.0ms** true
output skew where the API claimed 7.9 / 19.0ms at the same instants. The
engine is genuinely tight, but every API-derived figure in this document is
optimistic by roughly that residual - decode and output buffering the player
clock cannot see. Measured on the HTML5 path (a cross-origin iframe cannot
be audio-tapped), so it is indicative for the YouTube path rather than a
measurement of it.

## 9. Known limitations

- **Ads/interstitials**: the embedded player can be interrupted by content
  we cannot observe; repeated refused plays surface a click-to-resume chip
  instead of fighting. A production sync product ultimately needs an owned
  player for controllable content.
- **Path asymmetry** biases θ by asym/2 — measured and displayed (S6), not
  correctable by any NTP-family scheme.
- **Background tabs** are suspended, not synced; they resync on focus.
- Published drift figures are player-API derived and therefore optimistic
  by the residual measured in §8a; the audio-truth number is the honest one.
- Tokens are verified at connect only; REST room mutation still trusts the
  body; voice rosters are per-instance (the voice mesh is not the sync
  plane). Each is a deliberate scope cut, documented rather than hidden.

## 10. Future work

Predictive clock-discipline control (RLS skew estimation + PI servo) where
fractional rates permit; signal-truth validation via per-client audio capture
and cross-correlation; a formally specified (TLA+) coordination protocol with
a second (Go) implementation; single-owner room actors with lease fencing as
the scale-out endgame. These are the M9–M13 tracks of this repo's plan.
