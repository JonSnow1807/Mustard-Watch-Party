// Load characterization: sync quality AND server health vs room size and
// instance count. Each cell spawns the bot fleet as a subprocess against the
// chosen topology while scraping every instance's /metrics; results join
// into one report with the knee and its attribution.
//
//   npx tsx src/sweep.ts                 # full matrix
//   npx tsx src/sweep.ts --sizes 10,50   # subset
//
// SLOs (a cell FAILS the knee when breached): bot P95 vs-timeline drift
// <= 250ms and event-loop lag p99 <= 100ms. The drift bound is calibrated
// ABOVE the fleet's load-independent floor (~165ms P95, set by the
// deliberately pessimistic SimPlayer latency/settle model and constant
// from n=10 to n=250) so it detects load-induced rise, not the simulation
// floor. Load-gen validity:
// host load average per core is recorded per cell; cells above 0.7 are
// flagged self-skewed.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import { join } from 'node:path';
import { Scraper, summarize } from './scrape.js';

interface Cell {
  label: string;
  n: number;
  rooms: number;
  ws: string;
  instances: Array<{ instance: string; url: string }>;
}

const THREE = [
  { instance: 'b1', url: 'http://localhost:3301' },
  { instance: 'b2', url: 'http://localhost:3302' },
  { instance: 'b3', url: 'http://localhost:3303' },
];
const ONE = [{ instance: 'b1', url: 'http://localhost:3301' }];

function parseSizes(): number[] {
  const i = process.argv.indexOf('--sizes');
  if (i >= 0) return process.argv[i + 1].split(',').map((x) => parseInt(x, 10));
  return [10, 25, 50, 100, 250];
}

const DURATION_S = 120;

async function runCell(cell: Cell, outDir: string): Promise<Record<string, unknown>> {
  console.log(`\n=== cell ${cell.label}: n=${cell.n} via ${cell.ws} ===`);
  const scraper = new Scraper(cell.instances);
  scraper.start();
  let botSummary: Record<string, unknown> | null = null;
  let error: string | null = null;
  try {
    // async spawn: execFileSync would block the event loop and starve the
    // metrics scraper for the whole cell
    const { stdout } = await execFileAsync(
      'npx',
      ['tsx', 'src/bots/run-bots.ts', '--n', String(cell.n), '--duration', String(DURATION_S), '--ws', cell.ws],
      { encoding: 'utf8', timeout: (DURATION_S + 120) * 1000, maxBuffer: 64 * 1024 * 1024 },
    );
    const m = stdout.match(/\[bots\] summary: ({[\s\S]*})/);
    if (m) botSummary = JSON.parse(m[1]) as Record<string, unknown>;
  } catch (e) {
    error = String(e);
  }
  const metricSamples = scraper.stop();
  const servers = summarize(metricSamples);
  const load1PerCore = loadavg()[0] / cpus().length;
  const drift = (botSummary?.driftMs ?? {}) as { p50?: number; p95?: number; p99?: number };
  const lagWorstMs = Math.max(...Object.values(servers).map((s) => s.lagP99MaxMs), 0);
  const result = {
    ...cell,
    instances: undefined,
    botSummary,
    servers,
    loadGenLoad1PerCore: load1PerCore,
    loadGenSelfSkewed: load1PerCore > 0.7,
    sloDriftOk: (drift.p95 ?? Infinity) <= 250,
    sloLagOk: lagWorstMs <= 100,
    error,
  };
  writeFileSync(join(outDir, `${cell.label}.json`), JSON.stringify({ ...result, metricSamples }, null, 2));
  console.log(
    `[cell ${cell.label}] driftP95=${drift.p95?.toFixed(0)}ms lagP99max=${lagWorstMs.toFixed(0)}ms ` +
      `cpu=${Object.values(servers).map((s) => s.cpuCoresAvg.toFixed(2)).join('/')} cores ` +
      `loadgen=${load1PerCore.toFixed(2)}${result.loadGenSelfSkewed ? ' (SELF-SKEWED)' : ''}`,
  );
  return result;
}

async function main(): Promise<void> {
  const sizes = parseSizes();
  const sweepId = `sweep-${Date.now().toString(36)}`;
  const outDir = join(process.cwd(), 'runs', sweepId);
  mkdirSync(outDir, { recursive: true });
  const cells: Cell[] = [];
  for (const n of sizes) {
    cells.push({ label: `one-${n}`, n, rooms: 1, ws: 'http://localhost:3301', instances: ONE });
    cells.push({ label: `three-${n}`, n, rooms: 1, ws: 'http://localhost:3300', instances: THREE });
  }
  const results: Array<Record<string, unknown>> = [];
  for (const cell of cells) {
    results.push(await runCell(cell, outDir));
  }
  writeFileSync(
    join(outDir, 'sweep-summary.json'),
    JSON.stringify(
      {
        sweepId,
        gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        hardware: `${cpus().length} cores (${cpus()[0]?.model ?? 'unknown'})`,
        durationSPerCell: DURATION_S,
        results: results.map((r) => ({ ...r, metricSamples: undefined })),
      },
      null,
      2,
    ),
  );
  console.log(`\nsweep written to ${outDir}`);
}

void main();
