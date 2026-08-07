// Render a committed sweep run into the SCALING.md results block: a drift-
// vs-room-size chart (1 vs 3 instances), a lag chart, and a markdown table
// with SLO/knee evaluation.
//   npx tsx src/sweep-report.ts runs/<sweepId>
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npx tsx src/sweep-report.ts runs/<sweepId>');
  process.exit(1);
}

interface CellResult {
  label: string;
  n: number;
  botSummary: {
    driftMs?: { p50: number; p95: number; p99: number };
    slopeMsPerMin?: number;
    seqGaps?: number;
    seqReorders?: number;
    seqDuplicates?: number;
    rejoinFailures?: number;
  } | null;
  servers: Record<string, { lagP99MaxMs: number; cpuCoresAvg: number; rssMaxMb: number }>;
  loadGenLoad1PerCore: number;
  loadGenSelfSkewed: boolean;
  sloDriftOk: boolean;
  sloLagOk: boolean;
}

const summary = JSON.parse(readFileSync(join(dir, 'sweep-summary.json'), 'utf8')) as {
  sweepId: string;
  gitSha: string;
  hardware: string;
  durationSPerCell: number;
  results: CellResult[];
};

async function renderSvg(spec: TopLevelSpec): Promise<string> {
  const compiled = vegaLite.compile(spec).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' });
  return await view.toSVG();
}

const rows = summary.results.map((r) => ({
  topology: r.label.startsWith('one') ? '1 instance' : '3 instances',
  n: r.n,
  p50: r.botSummary?.driftMs?.p50 ?? null,
  p95: r.botSummary?.driftMs?.p95 ?? null,
  p99: r.botSummary?.driftMs?.p99 ?? null,
  lagMax: Math.max(...Object.values(r.servers).map((s) => s.lagP99MaxMs), 0),
  cpuTotal: Object.values(r.servers).reduce((s, x) => s + x.cpuCoresAvg, 0),
  // integrity counters get their own column: an earlier sweep committed a
  // non-zero seqGaps that no table column showed, and a number that lives
  // only inside the artifact is invisible to a table reader
  gaps: r.botSummary?.seqGaps ?? null,
  reorders: r.botSummary?.seqReorders ?? null,
  dups: r.botSummary?.seqDuplicates ?? null,
  rejoinFailures: r.botSummary?.rejoinFailures ?? null,
  selfSkewed: r.loadGenSelfSkewed,
  sloOk: r.sloDriftOk && r.sloLagOk,
}));

mkdirSync(join(dir, 'charts'), { recursive: true });

const driftSpec: TopLevelSpec = {
  width: 640,
  height: 320,
  background: 'white',
  title: `protocol drift P95 vs room size — 1 vs 3 instances (${summary.durationSPerCell}s cells)`,
  data: { values: rows.filter((r) => r.p95 !== null) },
  mark: { type: 'line', point: true },
  encoding: {
    x: { field: 'n', type: 'quantitative', scale: { type: 'log' }, title: 'clients in one room' },
    y: { field: 'p95', type: 'quantitative', title: 'drift P95 (ms)' },
    color: { field: 'topology', type: 'nominal' },
    strokeDash: { field: 'selfSkewed', type: 'nominal', title: 'load-gen self-skewed' },
  },
} as TopLevelSpec;

const lagSpec: TopLevelSpec = {
  width: 640,
  height: 320,
  background: 'white',
  title: 'worst event-loop lag p99 vs room size',
  data: { values: rows },
  mark: { type: 'line', point: true },
  encoding: {
    x: { field: 'n', type: 'quantitative', scale: { type: 'log' }, title: 'clients in one room' },
    y: { field: 'lagMax', type: 'quantitative', title: 'event-loop lag p99 max (ms)' },
    color: { field: 'topology', type: 'nominal' },
  },
} as TopLevelSpec;

writeFileSync(join(dir, 'charts', 'sweep-drift.svg'), await renderSvg(driftSpec));
writeFileSync(join(dir, 'charts', 'sweep-lag.svg'), await renderSvg(lagSpec));

const fmt = (x: number | null): string => (x === null ? '—' : `${Math.round(x)}ms`);
const lines = [
  `Sweep \`${summary.sweepId}\` · ${summary.hardware} · ${summary.durationSPerCell}s cells · SHA \`${summary.gitSha.slice(0, 10)}\``,
  '',
  '| topology | clients | drift P50 | P95 | P99 | lag p99 max | server CPU (cores) | gaps/reord/dups | SLO | load-gen |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      // a failed re-join leaves that bot deaf: every seq after its drop falls
      // outside the gap metric's observable range, so a clean gap count over
      // deaf bots is a lower bound, not integrity - mark the cell
      `| ${r.topology} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${fmt(r.lagMax)} | ${r.cpuTotal.toFixed(2)} | ${r.gaps ?? '—'}/${r.reorders ?? '—'}/${r.dups ?? '—'}${(r.rejoinFailures ?? 0) > 0 ? ` ⚠ ${r.rejoinFailures} deaf` : ''} | ${r.sloOk ? 'ok' : 'BREACH'} | ${r.selfSkewed ? 'SELF-SKEWED' : 'valid'} |`,
  ),
];

const deaf = rows.filter((r) => (r.rejoinFailures ?? 0) > 0);
if (deaf.length > 0) {
  lines.push(
    '',
    `⚠ ${deaf.length} cell(s) had bots that failed to re-join after a ` +
      'reconnect. A deaf bot cannot observe the seqs it misses, so its gap ' +
      'count is a lower bound and the integrity column for those cells is ' +
      'incomplete, not clean.',
  );
}

// knee: smallest N with an SLO breach on a valid cell, per topology
for (const topo of ['1 instance', '3 instances']) {
  const breach = rows
    .filter((r) => r.topology === topo && !r.selfSkewed && !r.sloOk)
    .sort((a, b) => a.n - b.n)[0];
  lines.push(
    '',
    breach
      ? `**${topo} knee:** SLO breach at n=${breach.n} (drift P95 ${fmt(breach.p95)}, lag ${fmt(breach.lagMax)}).`
      : `**${topo}:** no SLO breach on any valid cell in this sweep.`,
  );
}

writeFileSync(join(dir, 'sweep-table.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
