// The telemetry contract with the app's read-only shim (window.__mustardSync).
// Kept harness-local on purpose: the harness must measure the pre-overhaul and
// post-overhaul engines identically, so it cannot depend on app-internal types.

export interface ShimSample {
  /** page Date.now() at sample time; same physical clock as the harness host */
  tLocal: number;
  /** player.getCurrentTime() in seconds */
  playerTime: number;
  /** YT.PlayerState numeric value (1 = PLAYING, 2 = PAUSED, 3 = BUFFERING) */
  playerState: number;
  /** app-reported RTT estimate in ms (whatever the app currently measures) */
  rtt: number;
}

export interface CollectedSample extends ShimSample {
  client: number;
}

export type ImpairmentTool = 'none' | 'toxiproxy' | 'netem';

export interface Impairment {
  tool: ImpairmentTool;
  /** one-way delay applied client->server, ms (toxiproxy upstream toxic) */
  upLatencyMs?: number;
  /** one-way delay applied server->client, ms (toxiproxy downstream toxic) */
  downLatencyMs?: number;
  /** +/- jitter on each direction, ms (toxiproxy latency toxic jitter field) */
  upJitterMs?: number;
  downJitterMs?: number;
  /** raw tc-netem qdisc spec applied inside the netem proxy container */
  netemSpec?: string;
}

export interface ScenarioSpec {
  id: string;
  title: string;
  must: boolean;
  impairment: Impairment;
  /** total scripted duration, seconds */
  durationS: number;
}

export interface ActionEvent {
  /** host Date.now() when the harness performed the action */
  tHost: number;
  client: number;
  kind: 'join' | 'play' | 'pause' | 'seek' | 'scenario-start' | 'scenario-end';
  detail?: string;
}

export interface RunMeta {
  runId: string;
  scenario: ScenarioSpec;
  gitSha: string;
  startedAt: string;
  clients: number;
  videoId: string;
  wsUrl: string;
  hardware: string;
  engine: 'baseline' | 'overhauled';
  notes?: string;
}

export interface DriftStats {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  samples: number;
}

export interface RunStats {
  /** absolute pairwise |Δ playerTime| across the common grid, seconds */
  pairwiseSteadyState: DriftStats;
  pairwiseAllTime: DriftStats;
  /** per join/seek event: seconds until all pairs within threshold for 3 grid points */
  convergenceAfterEventsS: Array<{ event: string; tHost: number; convergenceS: number | null }>;
  hardSeeksPerMinute: number;
  /** getCurrentTime quantization: plateau lengths (ms) and per-50ms increments (s) */
  noiseFloor: {
    plateauMsP50: number;
    plateauMsP95: number;
    incrementP50: number;
    incrementP95: number;
  };
}
