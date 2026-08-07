import type { ScenarioSpec } from './types.js';
import {
  classifyMediaSource,
  isAcceptableVideoUrl,
  type MediaSource,
} from '../../shared/media-source';

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
  // HONESTY NOTE for S8/S9: netem duplicate/reorder operate on TCP
  // SEGMENTS, and TCP dedupes and re-orders its own stream - the app never
  // sees a duplicated or reordered message from these. What they actually
  // stress is TCP-level pathology: duplicate-ACK processing and
  // head-of-line blocking on reassembly, i.e. latency variance. The
  // app-level duplicate/reorder proof is the bot fleet's --dup-controls
  // injection (SYNC_DESIGN 2a), not a transport toxic.
  S8: {
    id: 'S8',
    title: '25ms + 5% TCP-segment duplication (netem) — dup-ACK pathology',
    must: false,
    impairment: { tool: 'netem', netemSpec: 'delay 25ms duplicate 5%' },
    durationS: 240,
  },
  S9: {
    id: 'S9',
    title: '40ms with 25% segments sent ahead (netem reorder) — HoL blocking',
    must: false,
    impairment: { tool: 'netem', netemSpec: 'delay 40ms reorder 25% 50%' },
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
const DEFAULT_VIDEO_URL = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

/**
 * The video a run measures. HARNESS_VIDEO_URL selects the source arm for
 * the source matrix (file/hls/vimeo instead of the default YouTube), and
 * it is classified HERE, once, with the same shared rule the app enforces:
 * a URL the app would refuse dies at startup with the classification in
 * the error - not forty minutes into a run as a black-frame measurement
 * of nothing.
 */
export const TEST_VIDEO_URL =
  process.env.HARNESS_VIDEO_URL ?? DEFAULT_VIDEO_URL;
const classified = classifyMediaSource(TEST_VIDEO_URL);
// the ADMISSION rule, not just classification: the player attempts
// admissible-but-unknown URLs and fails visibly, which for a measurement
// run means forty minutes of black frames - so the harness refuses at
// startup everything the app would refuse at the door, plus nothing else
if (!isAcceptableVideoUrl(TEST_VIDEO_URL) || classified.kind === 'none') {
  throw new Error(
    `HARNESS_VIDEO_URL fails the app's admission rule: "${TEST_VIDEO_URL}"`,
  );
}
export const TEST_VIDEO_SOURCE: Exclude<MediaSource, { kind: 'none' }> =
  classified;

/**
 * Provider id where one exists, the raw URL otherwise - what RunMeta
 * stamps as videoId. Derived from the classification instead of hardcoded
 * so the stamp can never disagree with what the run actually played.
 */
export const TEST_VIDEO_ID =
  TEST_VIDEO_SOURCE.kind === 'youtube' || TEST_VIDEO_SOURCE.kind === 'vimeo'
    ? TEST_VIDEO_SOURCE.videoId
    : TEST_VIDEO_URL;
