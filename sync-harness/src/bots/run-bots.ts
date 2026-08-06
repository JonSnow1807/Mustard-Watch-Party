// Protocol-level sync regression: N bots (identical shared sync core, real
// JWT auth path, SimPlayers with injected clock offsets/skews) in one room,
// scripted control events, hard gates on the results.
//
//   npx tsx src/bots/run-bots.ts --n 10 --duration 90 [--gate]
//
// Gates (CI tripwire values — deliberately loose for 2-vCPU shared runners;
// headline numbers come from local hardware-documented runs, never CI):
//   - steady-state P95 |vs-timeline drift| < 250ms
//   - |P50 drift slope| over the run < 10ms/min (no unbounded growth)
//   - zero unrepaired seq regressions, zero handler errors
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoom } from '../app-api.js';
import { percentile } from '../stats.js';
import { BotClient } from './bot-client.js';
import { mulberry32 } from './sim-player.js';

interface Args {
  n: number;
  durationS: number;
  gate: boolean;
  wsUrl: string;
  controller: 'reactive' | 'predictive';
  plane: 'node' | 'relay';
  dupControls: boolean;
}

function parseArgs(): Args {
  const get = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  return {
    n: parseInt(get('--n') ?? '10', 10),
    durationS: parseInt(get('--duration') ?? '90', 10),
    gate: process.argv.includes('--gate'),
    wsUrl: get('--ws') ?? 'http://localhost:3000',
    controller: (get('--controller') ?? 'reactive') as 'reactive' | 'predictive',
    plane: (get('--plane') ?? 'node') as 'node' | 'relay',
    // exactly-once proof mode: every control sent twice with the same cmdId
    dupControls: process.argv.includes('--dup-controls'),
  };
}

import { execSync } from 'node:child_process';
import { cpus } from 'node:os';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs();
  // fixtures must live on the same topology the sockets hit (JWT secrets
  // and databases differ between the host backend and the lab)
  if (!process.env.HARNESS_API_URL) {
    // relay plane: fixtures (users/JWTs/rooms) still come from the node
    // backend - the relay verifies the same JWT secret
    process.env.HARNESS_API_URL =
      args.plane === 'relay' ? 'http://localhost:3000/api' : `${args.wsUrl}/api`;
  }
  const runId = `bots-${Date.now().toString(36)}`;
  const rng = mulberry32(12345);
  console.log(`[bots] ${args.n} bots, ${args.durationS}s, gate=${args.gate}`);

  const bots: BotClient[] = [];
  for (let i = 0; i < args.n; i++) {
    bots.push(
      new BotClient({
        index: i,
        runId,
        wsUrl: args.wsUrl,
        clockOffsetMs: (rng() - 0.5) * 2000, // ±1s injected offsets
        clockSkew: (rng() - 0.5) * 160e-6, // ±80ppm
        seed: 1000 + i,
        controller: args.controller,
        plane: args.plane,
        duplicateControls: args.dupControls,
        player: {
          playbackSkew: (rng() - 0.5) * 160e-6,
          // A/B fairness: both controller arms face fractional-capable
          // players (measured reality: the probe passes on real YouTube)
          fractionalRateOK: true,
        },
      }),
    );
  }

  // bot 0 is the commander and must own the room (controls are permission-
  // checked server-side against the verified identity)
  await bots[0].connect();
  const room = await createRoom(bots[0].user, runId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');

  // batched connects to be kind to the register endpoint
  const BATCH = 25;
  for (let i = 1; i < bots.length; i += BATCH) {
    await Promise.all(bots.slice(i, i + BATCH).map((b) => b.connect()));
  }
  for (let i = 0; i < bots.length; i += BATCH) {
    await Promise.all(bots.slice(i, i + BATCH).map((b) => b.join(room.code)));
  }
  bots.forEach((b) => b.start());
  console.log('[bots] all joined, starting scenario');

  // Fixed early schedule (not duration-proportional): all control events
  // land inside the first 60s so that everything after t=70s is a
  // guaranteed-quiet segment - that's where the growth gate measures.
  // pause freezes at the projected position, resume continues from it
  // (P4 semantics; a resume-from-0 would be a teleport, not a resume).
  const commander = bots[0];
  const t0 = Date.now();
  const projectedNow = (): number => {
    const tl = (commander as unknown as { timeline: { mediaTime: number; stampedAt: number; isPlaying: boolean } | null }).timeline;
    if (!tl) return 0;
    return tl.mediaTime + (tl.isPlaying ? (Date.now() - tl.stampedAt) / 1000 : 0);
  };
  const events: Array<{ atS: number; run: () => void }> = [
    { atS: 5, run: () => commander.sendIntent(room.code, 'play', 0) },
    { atS: 30, run: () => commander.sendIntent(room.code, 'seek', 300) },
    { atS: 40, run: () => bots[Math.min(2, bots.length - 1)].scriptedStall(4000) },
    { atS: 50, run: () => commander.sendIntent(room.code, 'pause', projectedNow()) },
    { atS: 55, run: () => commander.sendIntent(room.code, 'play', projectedNow()) },
  ];
  for (const e of events) {
    const wait = t0 + e.atS * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    e.run();
  }
  const remaining = t0 + args.durationS * 1000 - Date.now();
  if (remaining > 0) await sleep(remaining);

  const reports = bots.map((b) => b.report());
  bots.forEach((b) => b.dispose());

  // ---- analysis ----
  const controlAtMs = events
    .filter((_, i) => i !== 2)
    .map((e) => t0 + e.atS * 1000);
  const steady = (t: number): boolean =>
    t - t0 > 15_000 && !controlAtMs.some((c) => t >= c && t - c < 5_000);

  const steadyDrifts: number[] = [];
  const timeBuckets = new Map<number, number[]>();
  let thetaErrors: number[] = [];
  for (const r of reports) {
    for (const s of r.samples) {
      if (s.driftS !== null && steady(s.tReal)) {
        steadyDrifts.push(Math.abs(s.driftS) * 1000);
        const bucket = Math.floor((s.tReal - t0) / 10_000);
        const arr = timeBuckets.get(bucket) ?? [];
        arr.push(Math.abs(s.driftS) * 1000);
        timeBuckets.set(bucket, arr);
      }
      if (s.thetaErrorMs !== null && steady(s.tReal)) {
        thetaErrors.push(Math.abs(s.thetaErrorMs));
      }
    }
  }
  const sorted = [...steadyDrifts].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);

  // drift slope: linear fit of per-10s-bucket P50s over the quiet segment
  // (t >= 70s, after the last scripted event + settling) - unbounded growth
  // is a steady-state property; transients made this gate flap on slow CI
  const allBuckets = [...timeBuckets.entries()].sort((a, b) => a[0] - b[0]);
  const buckets = allBuckets
    .filter(([k]) => k >= 7)
    .map(([k, v]) => ({ x: k, y: percentile([...v].sort((a, b) => a - b), 50) }));
  let slopeMsPerMin = 0;
  if (buckets.length >= 3) {
    const n = buckets.length;
    const mx = buckets.reduce((s, b) => s + b.x, 0) / n;
    const my = buckets.reduce((s, b) => s + b.y, 0) / n;
    const num = buckets.reduce((s, b) => s + (b.x - mx) * (b.y - my), 0);
    const den = buckets.reduce((s, b) => s + (b.x - mx) ** 2, 0);
    slopeMsPerMin = den > 0 ? (num / den) * 6 : 0; // per-bucket=10s → ×6 per min
  }

  const seqGaps = reports.flatMap((r) => r.seqGaps);
  const seqReorders = reports.reduce((sum, r) => sum + r.seqReorders, 0);
  const seqDuplicates = reports.reduce((sum, r) => sum + r.seqDuplicates, 0);
  const reconnects = reports.reduce((sum, r) => sum + r.reconnects, 0);
  const rejoinFailures = reports.reduce((sum, r) => sum + r.rejoinFailures, 0);
  const dupControlsSent = reports.reduce((sum, r) => sum + r.dupControlsSent, 0);
  const handlerErrors = reports.flatMap((r) => r.handlerErrors);
  const thetaP95 = percentile(
    [...thetaErrors].sort((a, b) => a - b),
    95,
  );

  const summary = {
    runId,
    // provenance: an earlier audit found bot-fleet numbers published without
    // a citable artifact; a summary that names its build and hardware can be
    // committed under docs/measurements and pass the two-tier convention.
    // A dirty tree is STAMPED as dirty - a SHA that does not contain the
    // code that produced the run is worse than no SHA.
    gitSha:
      execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() +
      (execSync('git status --porcelain', { encoding: 'utf8' }).trim()
        ? '-dirty'
        : ''),
    hardware: `${cpus().length} cores (${cpus()[0]?.model ?? 'unknown'})`,
    controller: args.controller,
    plane: args.plane,
    n: args.n,
    durationS: args.durationS,
    steadySamples: steadyDrifts.length,
    driftMs: { p50, p95, p99 },
    slopeMsPerMin,
    thetaErrorP95Ms: thetaP95,
    seqGaps: seqGaps.length,
    // reordered deliveries are expected on a multi-instance fanout and are
    // dropped by the client's (storeEpoch, seq) ordering; reported so they
    // are visible without being mistaken for loss
    seqReorders,
    // duplicates are the repair sweep doing its job (or a join racing a
    // broadcast); idempotent, and deliberately not lumped in with reorders
    seqDuplicates,
    reconnects,
    // a bot that could not re-join is deaf, and its missed seqs fall outside
    // the gap metric's range - so a non-zero count here means the seqGaps
    // number above is an UNDER-count, not a clean bill of health
    rejoinFailures,
    // duplicate-injection mode: extra same-cmdId sends. With dedup working,
    // these produce ZERO extra seqs - any double-apply shows as a phantom
    // seq in the integrity counters
    dupControlsSent,
    handlerErrors: handlerErrors.length,
    rejectedControls: reports.reduce((s, r) => s + r.rejected, 0),
  };
  const outDir = join(process.cwd(), 'runs', runId);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'bots-summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(outDir, 'bots-samples.ndjson'),
    reports.flatMap((r) => r.samples.map((s) => JSON.stringify(s))).join('\n'),
  );
  console.log('[bots] summary:', JSON.stringify(summary, null, 2));

  if (args.gate) {
    const failures: string[] = [];
    if (!(p95 < 250)) failures.push(`P95 drift ${p95.toFixed(0)}ms >= 250ms`);
    if (!(Math.abs(slopeMsPerMin) < 15))
      failures.push(`drift slope ${slopeMsPerMin.toFixed(1)}ms/min >= 15`);
    if (seqGaps.length > 0) failures.push(`${seqGaps.length} seq gaps`);
    if (handlerErrors.length > 0) failures.push(`${handlerErrors.length} handler errors`);
    // failing re-joins silently shrink what the gap check can see, so the
    // gate has to treat them as a failure rather than trust a clean seqGaps
    if (rejoinFailures > 0) failures.push(`${rejoinFailures} failed re-joins (gap metric is blind past these)`);
    if (failures.length > 0) {
      console.error('[gate] FAILED:\n  ' + failures.join('\n  '));
      process.exit(1);
    }
    console.log('[gate] PASSED');
  }
}

void main();
