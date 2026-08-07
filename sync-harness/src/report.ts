import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ActionEvent, CollectedSample, RunMeta, RunStats } from './types.js';
import type { PairwisePoint } from './stats.js';
import {
  driftCdfSvg,
  driftTimeSeriesSvg,
  noiseHistogramSvg,
  playheadTimeSeriesSvg,
} from './charts.js';

const fmtMs = (s: number): string => (Number.isFinite(s) ? `${Math.round(s * 1000)}ms` : 'n/a');

// Same guard for values already in milliseconds. percentile() over an empty
// array is NaN, which .toFixed renders as "NaN" in the report and JSON
// serializes as null - a run with too few playing samples to measure the
// noise floor must SAY so, not print garbage.
const fmtRawMs = (v: number, digits: number): string =>
  Number.isFinite(v) ? `${v.toFixed(digits)}ms` : 'n/a';


export async function writeRun(
  dir: string,
  meta: RunMeta,
  samples: CollectedSample[],
  events: ActionEvent[],
  stats: RunStats,
  pairwiseSeries: PairwisePoint[],
): Promise<void> {
  mkdirSync(join(dir, 'charts'), { recursive: true });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  writeFileSync(
    join(dir, 'samples.ndjson'),
    samples.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2));
  writeFileSync(join(dir, 'stats.json'), JSON.stringify(stats, null, 2));

  const tStart = Math.min(...samples.map((s) => s.tLocal));
  const title = `${meta.scenario.id} · ${meta.engine} · ${meta.scenario.title}`;
  writeFileSync(join(dir, 'charts', 'drift-cdf.svg'), await driftCdfSvg(pairwiseSeries, title));
  writeFileSync(
    join(dir, 'charts', 'drift-timeseries.svg'),
    await driftTimeSeriesSvg(pairwiseSeries, events, tStart, title),
  );

  // per-client playhead (1s downsample): makes total-failure runs legible —
  // a follower that never starts is a flatline against the host's climb
  const playhead: Array<{ tS: number; playheadS: number; client: string }> = [];
  const lastEmitted = new Map<number, number>();
  for (const s of samples) {
    const tS = Math.floor((s.tLocal - tStart) / 1000);
    if (lastEmitted.get(s.client) === tS) continue;
    lastEmitted.set(s.client, tS);
    playhead.push({ tS, playheadS: s.playerTime, client: `c${s.client}` });
  }
  writeFileSync(
    join(dir, 'charts', 'playhead-timeseries.svg'),
    await playheadTimeSeriesSvg(playhead, `per-client playhead · ${title}`),
  );

  const increments: Array<{ incrementMs: number }> = [];
  const byClient = new Map<number, CollectedSample[]>();
  for (const s of samples) {
    const arr = byClient.get(s.client) ?? [];
    arr.push(s);
    byClient.set(s.client, arr);
  }
  for (const arr of byClient.values()) {
    arr.sort((a, b) => a.tLocal - b.tLocal);
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].playerState === 1 && arr[i - 1].playerState === 1 && arr[i].tLocal - arr[i - 1].tLocal < 200) {
        increments.push({ incrementMs: (arr[i].playerTime - arr[i - 1].playerTime) * 1000 });
      }
    }
  }
  writeFileSync(
    join(dir, 'charts', 'noise-histogram.svg'),
    await noiseHistogramSvg(increments, `getCurrentTime quantization · ${meta.scenario.id}`),
  );

  const md = `# Run ${meta.runId} — ${meta.scenario.id} (${meta.engine})

${meta.scenario.title}

- git SHA: \`${meta.gitSha}\`
- started: ${meta.startedAt}
- clients: ${meta.clients} · video: \`${meta.videoId}\` · ws: \`${meta.wsUrl}\`
- hardware: ${meta.hardware}

## Pairwise |drift| (steady-state windows)

| P50 | P95 | P99 | max | samples |
|-----|-----|-----|-----|---------|
| ${fmtMs(stats.pairwiseSteadyState.p50)} | ${fmtMs(stats.pairwiseSteadyState.p95)} | ${fmtMs(stats.pairwiseSteadyState.p99)} | ${fmtMs(stats.pairwiseSteadyState.max)} | ${stats.pairwiseSteadyState.samples} |

All-time (incl. warmup + post-control): P50 ${fmtMs(stats.pairwiseAllTime.p50)}, P95 ${fmtMs(
    stats.pairwiseAllTime.p95,
  )}, P99 ${fmtMs(stats.pairwiseAllTime.p99)}.

Hard seeks/minute: ${stats.hardSeeksPerMinute.toFixed(2)}

## Convergence after control events

${stats.convergenceAfterEventsS
  .map((c) => `- ${c.event}: ${c.convergenceS === null ? 'never converged (< 150ms for 3 grid points)' : c.convergenceS.toFixed(2) + 's'}`)
  .join('\n')}

## getCurrentTime noise floor

Plateau length P50/P95: ${fmtRawMs(stats.noiseFloor.plateauMsP50, 0)} / ${fmtRawMs(stats.noiseFloor.plateauMsP95, 0)}.
Per-50ms increment P50/P95: ${fmtRawMs(stats.noiseFloor.incrementP50 * 1000, 1)} / ${fmtRawMs(stats.noiseFloor.incrementP95 * 1000, 1)}.

![CDF](charts/drift-cdf.svg)
![Time series](charts/drift-timeseries.svg)
![Noise](charts/noise-histogram.svg)
`;
  writeFileSync(join(dir, 'report.md'), md);
}
