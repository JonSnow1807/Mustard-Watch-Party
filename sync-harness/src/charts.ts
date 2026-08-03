import * as vega from 'vega';
import * as vegaLite from 'vega-lite';
import type { TopLevelSpec } from 'vega-lite';
import type { ActionEvent } from './types.js';
import type { PairwisePoint } from './stats.js';

async function renderSvg(spec: TopLevelSpec): Promise<string> {
  const compiled = vegaLite.compile(spec).spec;
  const view = new vega.View(vega.parse(compiled), { renderer: 'none' });
  return await view.toSVG();
}

const BASE: Partial<TopLevelSpec> = {
  width: 640,
  height: 320,
  background: 'white',
};

export async function driftCdfSvg(points: PairwisePoint[], title: string): Promise<string> {
  const values = points.map((p) => ({ driftMs: p.driftS * 1000 }));
  return renderSvg({
    ...BASE,
    title,
    data: { values },
    transform: [
      { sort: [{ field: 'driftMs' }], window: [{ op: 'percent_rank', as: 'cdf' }], frame: [null, 0] },
    ],
    mark: { type: 'line', interpolate: 'step-after' },
    encoding: {
      x: {
        field: 'driftMs',
        type: 'quantitative',
        title: 'pairwise |drift| (ms)',
        scale: { type: 'symlog', constant: 100 },
      },
      y: { field: 'cdf', type: 'quantitative', title: 'CDF' },
    },
  } as TopLevelSpec);
}

export async function driftTimeSeriesSvg(
  points: PairwisePoint[],
  events: ActionEvent[],
  tStart: number,
  title: string,
): Promise<string> {
  const values = points.map((p) => ({
    tS: p.t / 1000,
    driftMs: p.driftS * 1000,
    pair: p.pair,
  }));
  const eventValues = events
    .filter((e) => ['play', 'pause', 'seek', 'join'].includes(e.kind))
    .map((e) => ({ tS: (e.tHost - tStart) / 1000, kind: `${e.kind} c${e.client}` }));
  return renderSvg({
    ...BASE,
    title,
    layer: [
      {
        data: { values },
        mark: { type: 'line', opacity: 0.8 },
        encoding: {
          x: { field: 'tS', type: 'quantitative', title: 'scenario time (s)' },
          y: {
            field: 'driftMs',
            type: 'quantitative',
            title: 'pairwise |drift| (ms)',
            scale: { type: 'symlog', constant: 100 },
          },
          color: { field: 'pair', type: 'nominal', title: 'client pair' },
        },
      },
      {
        data: { values: eventValues },
        mark: { type: 'rule', strokeDash: [4, 3], color: '#888' },
        encoding: { x: { field: 'tS', type: 'quantitative' } },
      },
      {
        data: { values: eventValues },
        mark: { type: 'text', angle: 270, dy: -4, align: 'left', baseline: 'bottom', color: '#555', fontSize: 9 },
        encoding: {
          x: { field: 'tS', type: 'quantitative' },
          y: { value: 0 },
          text: { field: 'kind' },
        },
      },
    ],
  } as TopLevelSpec);
}

export async function playheadTimeSeriesSvg(
  samples: Array<{ tS: number; playheadS: number; client: string }>,
  title: string,
): Promise<string> {
  return renderSvg({
    ...BASE,
    title,
    data: { values: samples },
    mark: { type: 'line' },
    encoding: {
      x: { field: 'tS', type: 'quantitative', title: 'scenario time (s)' },
      y: { field: 'playheadS', type: 'quantitative', title: 'playhead (s)' },
      color: { field: 'client', type: 'nominal', title: 'client' },
    },
  } as TopLevelSpec);
}

export async function noiseHistogramSvg(
  increments: Array<{ incrementMs: number }>,
  title: string,
): Promise<string> {
  return renderSvg({
    ...BASE,
    title,
    data: { values: increments },
    mark: 'bar',
    encoding: {
      x: {
        field: 'incrementMs',
        type: 'quantitative',
        bin: { maxbins: 60 },
        title: 'getCurrentTime increment per 50ms sample (ms)',
      },
      y: { aggregate: 'count', type: 'quantitative', scale: { type: 'symlog' }, title: 'count' },
    },
  } as TopLevelSpec);
}
