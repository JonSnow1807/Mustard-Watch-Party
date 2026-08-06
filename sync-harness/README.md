# sync-harness

Measurement harness for Mustard Watch Party. Drives N real Chrome instances
through a deterministic watch-party scenario — staggered joins, play, seek,
pause/resume, hands-off steady state — under controlled network impairment,
and reports **cross-client playback drift distributions** (P50/P95/P99), not
adjectives.

## Methodology in one page

- **Instrument independence.** The app exposes a read-only 20Hz telemetry ring
  (`window.__mustardSync`: `{tLocal, playerTime, playerState, rtt}`). The shim
  never calls a mutating player API, so a measured run exercises the app
  exactly as shipped. The harness polls each page's ring every 250ms over CDP.
- **Common clock.** All browsers run on the harness host, so `tLocal`
  (page `Date.now()`) is the same physical clock across clients — pairwise
  comparisons never depend on the app's own clock-sync (the instrument doesn't
  grade itself).
- **Pairwise drift.** Each client's `playerTime` is linearly interpolated onto
  a shared 250ms grid (within contiguous PLAYING spans only); drift is
  `|playerTime_i(t) − playerTime_j(t)|` for every pair. Steady-state windows
  exclude the first 15s and 5s after any control event; all-time numbers are
  also reported, labeled.
- **Impairment.**
  - *Toxiproxy* (`ws://localhost:3101`): per-direction latency/jitter toxics —
    the only clean way to build asymmetric paths. Toxiproxy has **no
    packet-loss toxic** (it proxies TCP; loss is a packet-level phenomenon).
  - *netem proxy container* (`ws://localhost:3102`): nginx stream proxy with
    `tc netem` on its egress, `NET_ADMIN` only inside the container. One root
    qdisc impairs **both legs** of every round trip, so `delay X` adds 2X to
    RTT — scenario tables state one-way values. True random loss works here.
    Loss over TCP surfaces as bursty delay/head-of-line blocking — which is
    exactly the realistic condition being tested.
  - Only app traffic traverses a proxy. YouTube CDN traffic goes straight to
    the internet, unimpaired by construction.
- **Run validity.** After the scripted play, every client must reach PLAYING
  within 15s (consent walls / ads / interstitials fail this check rather than
  silently skewing data); a failed run is retried once, then marked FAILED.
  Poll failures are counted in the run output.
- **Provenance.** Every run directory records git SHA, scenario, impairment,
  hardware, and the raw samples. Published numbers drawn from a committed run
  directory trace back to one; figures measured locally without a committed
  run are tagged **[lab]** in the docs (see the provenance convention at the
  top of `docs/SYNC_DESIGN.md`). Some checks — `verify-m6.ts`,
  `bench-planes.ts` — assert on the console and write no run directory, so
  their numbers are reproducible but not citable.

## Prerequisites

- Node ≥ 20, Docker Desktop, Chrome (falls back to bundled Chromium).
- One-time: `cd sync-harness && npm install && npx playwright install chromium`

## Running

```bash
# 1. lab (postgres + toxiproxy + netem proxy)
docker compose -f sync-harness/lab/docker-compose.harness.yml up -d --build

# 2. backend on the host
cd video-sync-backend
DATABASE_URL='postgresql://videouser:videopass@localhost:5433/videosync' npx prisma migrate deploy
DATABASE_URL='postgresql://videouser:videopass@localhost:5433/videosync' npm run start:prod &

# 3. frontend production build, served statically on :3001
cd ../video-sync-frontend
npm run build
npx serve -s build -l 3001 &

# 4. scenarios
cd ../sync-harness
npm run scenario -- S0          # one scenario
npm run scenario -- S0,S2,S6    # several
npm run matrix                  # everything
```

Outputs land in `sync-harness/runs/<runId>/`: `samples.ndjson`, `events.json`,
`stats.json`, `report.md`, `charts/*.svg`. Published results are copied to
`docs/measurements/` with the run directory intact.

### netem smoke test (day-1 check)

Docker Desktop's VM kernel must ship `sch_netem`:

```bash
docker compose -f sync-harness/lab/docker-compose.harness.yml exec netem apply-netem "delay 1ms"
docker compose -f sync-harness/lab/docker-compose.harness.yml exec netem apply-netem ""
```

If the first command errors, run loss scenarios (S4/S5/S7) on a Linux host and
say so in the run notes; all other scenarios are Toxiproxy-based and
platform-independent.

## Scenario matrix

| ID | Impairment (one-way, per direction) | Tool | Status |
|----|-------------------------------------|------|--------|
| S0 | clean loopback | — | must |
| S1 | +40ms sym | Toxiproxy | optional |
| S2 | +150ms sym (~300ms RTT) | Toxiproxy | must |
| S3 | 50±30ms jitter sym | Toxiproxy | must |
| S4 | 25ms + 1% loss | netem | optional |
| S5 | 25ms + 5% loss | netem | must |
| S6 | asym 120ms up / 20ms down | Toxiproxy | must |
| S7 | 60±40ms + 2% loss | netem | optional |
| S8 | 25ms + 5% TCP-segment duplication | netem | optional† |
| S9 | 40ms, 25% segments sent ahead (reorder) | netem | optional† |

† S8/S9 are **TCP-pathology** scenarios, stated plainly: netem's duplicate
and reorder act on TCP segments, and TCP dedupes and re-orders its own
stream — the application never sees a duplicated or reordered message from
them. They stress dup-ACK processing and head-of-line blocking (latency
variance). The app-level duplicate proof is the bot fleet's
`--dup-controls` injection, which bypasses what TCP hides
(`docs/measurements/exactly-once/`).

Test video: Big Buck Bunny (Blender Foundation official upload, CC-BY,
embeddable, strong audio transients) — pinned in `src/scenarios.ts`.
