import type { ActionEvent, CollectedSample, DriftStats, RunStats } from './types.js';

const GRID_MS = 250;
const WARMUP_EXCLUDE_MS = 15_000;
const POST_CONTROL_EXCLUDE_MS = 5_000;
const CONVERGENCE_THRESHOLD_S = 0.15;
const CONVERGENCE_POINTS = 3;
const HARD_SEEK_JUMP_S = 1.5;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function driftStats(values: number[]): DriftStats {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : NaN,
    samples: sorted.length,
  };
}

interface ClientSeries {
  client: number;
  /** monotone tLocal samples, PLAYING only, split into contiguous spans */
  spans: Array<Array<{ t: number; pt: number }>>;
  all: CollectedSample[];
}

function buildSeries(samples: CollectedSample[], nClients: number): ClientSeries[] {
  const series: ClientSeries[] = [];
  for (let c = 0; c < nClients; c++) {
    const mine = samples
      .filter((s) => s.client === c)
      .sort((a, b) => a.tLocal - b.tLocal);
    const spans: ClientSeries['spans'] = [];
    let current: Array<{ t: number; pt: number }> = [];
    let prev: CollectedSample | null = null;
    for (const s of mine) {
      const playing = s.playerState === 1;
      const discontinuity =
        prev !== null &&
        (s.tLocal - prev.tLocal > 1000 ||
          Math.abs(s.playerTime - prev.playerTime) > HARD_SEEK_JUMP_S);
      if (!playing || discontinuity) {
        if (current.length > 1) spans.push(current);
        current = [];
      }
      if (playing) current.push({ t: s.tLocal, pt: s.playerTime });
      prev = s;
    }
    if (current.length > 1) spans.push(current);
    series.push({ client: c, spans, all: mine });
  }
  return series;
}

/** Linear interpolation of playerTime at host time t, within one span only. */
function interpolateAt(series: ClientSeries, t: number): number | null {
  for (const span of series.spans) {
    if (t < span[0].t || t > span[span.length - 1].t) continue;
    // binary search for the surrounding pair
    let lo = 0;
    let hi = span.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (span[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const a = span[lo];
    const b = span[hi];
    if (b.t === a.t) return a.pt;
    const f = (t - a.t) / (b.t - a.t);
    return a.pt + f * (b.pt - a.pt);
  }
  return null;
}

export interface PairwisePoint {
  t: number;
  pair: string;
  driftS: number;
}

export function computeStats(
  samples: CollectedSample[],
  events: ActionEvent[],
  nClients: number,
): { stats: RunStats; pairwiseSeries: PairwisePoint[] } {
  const series = buildSeries(samples, nClients);
  const t0 = Math.min(...samples.map((s) => s.tLocal));
  const t1 = Math.max(...samples.map((s) => s.tLocal));

  const controlEvents = events.filter((e) =>
    ['play', 'pause', 'seek', 'join'].includes(e.kind),
  );

  const excluded = (t: number): boolean => {
    if (t - t0 < WARMUP_EXCLUDE_MS) return true;
    return controlEvents.some(
      (e) => t >= e.tHost && t - e.tHost < POST_CONTROL_EXCLUDE_MS,
    );
  };

  const steady: number[] = [];
  const allTime: number[] = [];
  const pairwiseSeries: PairwisePoint[] = [];

  for (let t = t0; t <= t1; t += GRID_MS) {
    const values: Array<{ client: number; pt: number }> = [];
    for (const s of series) {
      const pt = interpolateAt(s, t);
      if (pt !== null) values.push({ client: s.client, pt });
    }
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const d = Math.abs(values[i].pt - values[j].pt);
        allTime.push(d);
        if (!excluded(t)) steady.push(d);
        pairwiseSeries.push({
          t: t - t0,
          pair: `${values[i].client}-${values[j].client}`,
          driftS: d,
        });
      }
    }
  }

  // convergence after each join/seek/play: first time all live pairs stay
  // under threshold for CONVERGENCE_POINTS consecutive grid points
  const convergence = controlEvents
    .filter((e) => e.kind !== 'pause')
    .map((e) => {
      let consecutive = 0;
      for (let t = e.tHost; t <= t1; t += GRID_MS) {
        const values: number[] = [];
        for (const s of series) {
          const pt = interpolateAt(s, t);
          if (pt !== null) values.push(pt);
        }
        let worst = 0;
        for (let i = 0; i < values.length; i++) {
          for (let j = i + 1; j < values.length; j++) {
            worst = Math.max(worst, Math.abs(values[i] - values[j]));
          }
        }
        if (values.length >= 2 && worst < CONVERGENCE_THRESHOLD_S) {
          consecutive += 1;
          if (consecutive >= CONVERGENCE_POINTS) {
            return {
              event: `${e.kind}@c${e.client}`,
              tHost: e.tHost,
              convergenceS: (t - e.tHost) / 1000 - ((CONVERGENCE_POINTS - 1) * GRID_MS) / 1000,
            };
          }
        } else {
          consecutive = 0;
        }
      }
      return { event: `${e.kind}@c${e.client}`, tHost: e.tHost, convergenceS: null };
    });

  // hard seeks: playerTime discontinuities while playing
  let hardSeeks = 0;
  for (const s of series) {
    const mine = s.all;
    for (let i = 1; i < mine.length; i++) {
      const a = mine[i - 1];
      const b = mine[i];
      if (
        a.playerState === 1 &&
        b.playerState === 1 &&
        b.tLocal - a.tLocal < 1000 &&
        Math.abs(b.playerTime - a.playerTime - (b.tLocal - a.tLocal) / 1000) > HARD_SEEK_JUMP_S
      ) {
        hardSeeks += 1;
      }
    }
  }
  const minutes = (t1 - t0) / 60_000;

  // noise floor: plateau lengths and increments of the 20Hz raw readout
  const plateaus: number[] = [];
  const increments: number[] = [];
  for (const s of series) {
    const mine = s.all.filter((x) => x.playerState === 1);
    let plateauStart: number | null = null;
    for (let i = 1; i < mine.length; i++) {
      if (mine[i].tLocal - mine[i - 1].tLocal > 200) {
        plateauStart = null;
        continue;
      }
      const inc = mine[i].playerTime - mine[i - 1].playerTime;
      increments.push(inc);
      if (inc === 0) {
        if (plateauStart === null) plateauStart = mine[i - 1].tLocal;
      } else if (plateauStart !== null) {
        plateaus.push(mine[i].tLocal - plateauStart);
        plateauStart = null;
      }
    }
  }
  const sortedPlateaus = plateaus.sort((a, b) => a - b);
  const sortedIncs = increments.sort((a, b) => a - b);

  const stats: RunStats = {
    pairwiseSteadyState: driftStats(steady),
    pairwiseAllTime: driftStats(allTime),
    convergenceAfterEventsS: convergence,
    hardSeeksPerMinute: minutes > 0 ? hardSeeks / minutes : 0,
    noiseFloor: {
      plateauMsP50: percentile(sortedPlateaus, 50),
      plateauMsP95: percentile(sortedPlateaus, 95),
      incrementP50: percentile(sortedIncs, 50),
      incrementP95: percentile(sortedIncs, 95),
    },
  };

  return { stats, pairwiseSeries };
}
