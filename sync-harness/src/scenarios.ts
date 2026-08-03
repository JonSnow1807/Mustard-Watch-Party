import type { ScenarioSpec } from './types.js';

// Impairment values are ONE-WAY, PER-DIRECTION delays. A netem `delay X` on
// the proxy container applies to both legs of every round trip, so it adds
// 2X to RTT; toxiproxy values are set per direction explicitly. Charts and
// reports must label scenarios with these semantics.
export const SCENARIOS: Record<string, ScenarioSpec> = {
  S0: {
    id: 'S0',
    title: 'clean loopback (floor; loopback is unrealistically kind)',
    must: true,
    impairment: { tool: 'none' },
    durationS: 240,
  },
  S1: {
    id: 'S1',
    title: '+40ms each way (~80ms RTT), symmetric',
    must: false,
    impairment: { tool: 'toxiproxy', upLatencyMs: 40, downLatencyMs: 40 },
    durationS: 240,
  },
  S2: {
    id: 'S2',
    title: '+150ms each way (~300ms RTT), symmetric — intercontinental',
    must: true,
    impairment: { tool: 'toxiproxy', upLatencyMs: 150, downLatencyMs: 150 },
    durationS: 240,
  },
  S3: {
    id: 'S3',
    title: '50±30ms jitter each way — wifi-ish variance',
    must: true,
    impairment: {
      tool: 'toxiproxy',
      upLatencyMs: 50,
      downLatencyMs: 50,
      upJitterMs: 30,
      downJitterMs: 30,
    },
    durationS: 240,
  },
  S4: {
    id: 'S4',
    title: '25ms + 1% loss (netem) — mild loss, TCP retransmit',
    must: false,
    impairment: { tool: 'netem', netemSpec: 'delay 25ms loss 1%' },
    durationS: 240,
  },
  S5: {
    id: 'S5',
    title: '25ms + 5% loss (netem) — ugly loss, stall behavior',
    must: true,
    impairment: { tool: 'netem', netemSpec: 'delay 25ms loss 5%' },
    durationS: 240,
  },
  S6: {
    id: 'S6',
    title: 'asymmetric 120ms up / 20ms down — NTP asymmetry-bias floor',
    must: true,
    impairment: { tool: 'toxiproxy', upLatencyMs: 120, downLatencyMs: 20 },
    durationS: 240,
  },
  S7: {
    id: 'S7',
    title: '60±40ms + 2% loss (netem) — bad wifi combo',
    must: false,
    impairment: { tool: 'netem', netemSpec: 'delay 60ms 40ms 25% loss 2%' },
    durationS: 240,
  },
};

// Deterministic scripted timeline (seconds from scenario start).
// Client 0 is the room creator and the only controller.
export const TIMELINE = {
  joinAtS: [0, 5, 10],
  playAtS: 30,
  seekAtS: 90,
  /** progress-bar click position for the scripted seek */
  seekToFraction: 0.5,
  pauseAtS: 150,
  resumeAtS: 155,
};

// Big Buck Bunny, Blender Foundation's official upload: CC-BY, embeddable,
// low-monetization, strong audio transients (also suits the M10 audio pass).
export const TEST_VIDEO_ID = 'aqz-KE-bpKQ';
export const TEST_VIDEO_URL = `https://www.youtube.com/watch?v=${TEST_VIDEO_ID}`;
