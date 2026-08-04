// Before/after packaging: reads committed baseline + after run dirs and
// emits the results markdown (README + SYNC_DESIGN blocks) plus a P95
// comparison chart.
//   npx tsx src/compare.ts ../docs/measurements/baseline ../docs/measurements/after
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';
import type { RunMeta, RunStats } from './types.js';

const [baselineDir, afterDir] = process.argv.slice(2);
if (!baselineDir || !afterDir) {
  console.error('usage: npx tsx src/compare.ts <baselineDir> <afterDir>');
  process.exit(1);
}

interface Run {
  meta: RunMeta;
  stats: RunStats;
}

function loadRuns(dir: string): Map<string, Run> {
  const out = new Map<string, Run>();
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(
        readFileSync(join(dir, entry.name, 'meta.json'), 'utf8'),
      ) as RunMeta;
      const stats = JSON.parse(
        readFileSync(join(dir, entry.name, 'stats.json'), 'utf8'),
      ) as RunStats;
      out.set(meta.scenario.id, { meta, stats });
    } catch {
      // not a run dir
    }
  }
  return out;
}

const baseline = loadRuns(baselineDir);
const after = loadRuns(afterDir);

const fmt = (s: number | undefined | null): string =>
  s === undefined || s === null || !Number.isFinite(s) ? '—' : s >= 10 ? `${s.toFixed(1)}s` : `${Math.round(s * 1000)}ms`;

const scenarioOrder = ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'];
const rows: string[] = [
  '| scenario (one-way impairment) | baseline P50 / P95 | overhauled P50 / P95 / P99 | convergence after seek |',
  '|---|---|---|---|',
];
const chartData: Array<{ scenario: string; engine: string; p95ms: number }> = [];

// A run whose meta says INVALID did not measure what it set out to measure.
// The baseline was already guarded; the AFTER run - the one that becomes the
// headline number - was formatted and charted unconditionally, so a botched
// run could be published as a result. Percentiles over a run that half failed
// are not a smaller result, they are not a result at all.
const invalid = (r: Run | undefined): boolean => !!r?.meta.notes?.includes('INVALID');

for (const id of scenarioOrder) {
  const a = after.get(id);
  if (!a) continue;
  const b = baseline.get(id);
  const bCell = !b
    ? 'not measured'
    : invalid(b)
      ? '**total failure** (followers never start)'
      : `${fmt(b.stats.pairwiseSteadyState.p50)} / ${fmt(b.stats.pairwiseSteadyState.p95)}`;
  const seekConv = a.stats.convergenceAfterEventsS.filter((c) => c.event.startsWith('seek'));
  const seekCell =
    invalid(a) || seekConv.length === 0 || seekConv[0].convergenceS === null
      ? '—'
      : `${seekConv[0].convergenceS.toFixed(2)}s`;
  const aCell = invalid(a)
    ? `**INVALID** — ${a.meta.notes}`
    : `${fmt(a.stats.pairwiseSteadyState.p50)} / ${fmt(a.stats.pairwiseSteadyState.p95)} / ${fmt(a.stats.pairwiseSteadyState.p99)}`;
  rows.push(
    `| ${id} — ${a.meta.scenario.title.split('—')[0].trim()} | ${bCell} | ${aCell} | ${seekCell} |`,
  );
  if (!invalid(a)) {
    chartData.push({ scenario: id, engine: 'overhauled', p95ms: a.stats.pairwiseSteadyState.p95 * 1000 });
  }
  if (b && !invalid(b)) {
    chartData.push({ scenario: id, engine: 'baseline', p95ms: b.stats.pairwiseSteadyState.p95 * 1000 });
  }
}

const hardSeeks = [...after.values()]
  .filter((r) => !invalid(r))
  .map((r) => `${r.meta.scenario.id}: ${r.stats.hardSeeksPerMinute.toFixed(2)}`);
if (hardSeeks.length > 0) {
  rows.push('', `Steady-state hard seeks per minute — ${hardSeeks.join(' · ')}.`);
}
const anyAfter = [...after.values()].find((r) => !invalid(r));
rows.push(
  '',
  `3 real Chrome clients, deterministic 240s scenario, ${anyAfter?.meta.hardware ?? ''}; ` +
    `runs committed with SHA + scenario + impairment per directory.`,
);

const md = rows.join('\n');
writeFileSync(join(afterDir, 'comparison-table.md'), md + '\n');
console.log(md);

const spec: TopLevelSpec = {
  width: 640,
  height: 320,
  background: 'white',
  title: 'steady-state pairwise drift P95 by network scenario',
  data: { values: chartData },
  mark: 'bar',
  encoding: {
    x: { field: 'scenario', type: 'nominal', title: null },
    xOffset: { field: 'engine' },
    y: {
      field: 'p95ms',
      type: 'quantitative',
      title: 'drift P95 (ms, log scale)',
      scale: { type: 'symlog', constant: 100 },
    },
    color: { field: 'engine', type: 'nominal' },
  },
} as TopLevelSpec;

const compiled = vegaLite.compile(spec).spec;
const view = new vega.View(vega.parse(compiled), { renderer: 'none' });
const svg = await view.toSVG();
writeFileSync(join(afterDir, 'p95-comparison.svg'), svg);
console.log(`\nchart: ${join(afterDir, 'p95-comparison.svg')}`);
