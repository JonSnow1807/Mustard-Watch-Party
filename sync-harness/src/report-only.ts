// Recompute stats + charts from an existing run directory (no browsers).
//   npm run report -- runs/<runId>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeStats } from './stats.js';
import { writeRun } from './report.js';
import type { ActionEvent, CollectedSample, RunMeta } from './types.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: npm run report -- runs/<runId>');
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunMeta;
const events = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')) as ActionEvent[];
const samples = readFileSync(join(dir, 'samples.ndjson'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as CollectedSample);

const { stats, pairwiseSeries } = computeStats(samples, events, meta.clients);
await writeRun(dir, meta, samples, events, stats, pairwiseSeries);
console.log(`recomputed ${dir}`);
