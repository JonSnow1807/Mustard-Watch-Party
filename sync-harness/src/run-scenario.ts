import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { backendHealthy, createRoom, registerUser } from './app-api.js';
import {
  ActionLog,
  Collector,
  clickPlay,
  clickSeek,
  launchBrowser,
  openClient,
  waitForPlaying,
  waitForShim,
  type HarnessClient,
} from './browser.js';
import { SCENARIOS, TEST_VIDEO_ID, TEST_VIDEO_URL, TIMELINE } from './scenarios.js';
import { computeStats } from './stats.js';
import { applyLatency, resetProxy, toxiproxyUp, TOXIPROXY_LISTEN_PORT } from './toxiproxy.js';
import { writeRun } from './report.js';
import type { RunMeta, ScenarioSpec } from './types.js';

const N_CLIENTS = 3;
const ENGINE = (process.env.HARNESS_ENGINE ?? 'baseline') as RunMeta['engine'];
const OUT_ROOT = process.env.HARNESS_OUT ?? join(process.cwd(), 'runs');
const COMPOSE = 'docker compose -f lab/docker-compose.harness.yml';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function sh(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function wsUrlFor(s: ScenarioSpec): string {
  if (s.impairment.tool === 'toxiproxy') return `ws://localhost:${TOXIPROXY_LISTEN_PORT}`;
  if (s.impairment.tool === 'netem') return 'ws://localhost:3102';
  return 'ws://localhost:3000';
}

async function configureImpairment(s: ScenarioSpec): Promise<void> {
  if (s.impairment.tool === 'toxiproxy') {
    if (!(await toxiproxyUp())) {
      throw new Error(`toxiproxy is not reachable — start the lab: ${COMPOSE} up -d`);
    }
    await resetProxy('host.docker.internal:3000');
    await applyLatency(s.impairment);
    console.log(`[lab] toxiproxy toxics applied for ${s.id}`);
  } else if (s.impairment.tool === 'netem') {
    sh(`${COMPOSE} exec -T netem apply-netem "${s.impairment.netemSpec}"`);
    console.log(`[lab] netem applied for ${s.id}: ${s.impairment.netemSpec}`);
  }
}

async function clearImpairment(s: ScenarioSpec): Promise<void> {
  try {
    if (s.impairment.tool === 'toxiproxy') await resetProxy('host.docker.internal:3000');
    if (s.impairment.tool === 'netem') sh(`${COMPOSE} exec -T netem apply-netem ""`);
  } catch (err) {
    console.warn('[lab] impairment cleanup failed:', err);
  }
}

async function runScenario(s: ScenarioSpec, attempt = 1): Promise<boolean> {
  const runId = `${s.id}-${ENGINE}-${Date.now().toString(36)}`;
  console.log(`\n=== ${s.id} (${s.title}) — run ${runId}, attempt ${attempt} ===`);

  if (!(await backendHealthy())) {
    throw new Error('backend is not healthy on :3000 — start it first (see sync-harness/README.md)');
  }
  await configureImpairment(s);

  const wsUrl = wsUrlFor(s);
  const users = await Promise.all(
    Array.from({ length: N_CLIENTS }, (_, i) => registerUser(runId, i)),
  );
  const room = await createRoom(users[0], runId, TEST_VIDEO_URL);
  console.log(`[fixture] room ${room.code}, host ${users[0].username}`);

  const browser = await launchBrowser();
  const clients: HarnessClient[] = [];
  const log = new ActionLog();
  const scenarioStart = Date.now();
  log.record('scenario-start', -1, s.id);

  try {
    // staggered joins per the scripted timeline
    for (let i = 0; i < N_CLIENTS; i++) {
      const waitS = TIMELINE.joinAtS[i] - (Date.now() - scenarioStart) / 1000;
      if (waitS > 0) await sleep(waitS * 1000);
      const c = await openClient(browser, i, users[i], room.code, wsUrl);
      clients.push(c);
      log.record('join', i);
      await waitForShim(c);
      console.log(`[client ${i}] joined, player ready`);
    }

    const collector = new Collector(clients);
    collector.start();

    const untilS = async (atS: number): Promise<void> => {
      const waitMs = scenarioStart + atS * 1000 - Date.now();
      if (waitMs > 0) await sleep(waitMs);
    };

    await untilS(TIMELINE.playAtS);
    await clickPlay(clients[0]);
    log.record('play', 0);
    console.log('[action] host pressed play');

    const healthy = await Promise.all(clients.map((c) => waitForPlaying(c)));
    if (!healthy.every(Boolean)) {
      console.warn(`[health] players not all PLAYING within deadline: ${healthy}`);
      await collector.stop();
      await browser.close();
      await clearImpairment(s);
      if (attempt < 2) return runScenario(s, attempt + 1);
      console.error(`[health] ${s.id} failed twice — aborting this scenario`);
      return false;
    }

    await untilS(TIMELINE.seekAtS);
    await clickSeek(clients[0], TIMELINE.seekToFraction);
    log.record('seek', 0, `fraction=${TIMELINE.seekToFraction}`);
    console.log('[action] host seeked');

    await untilS(TIMELINE.pauseAtS);
    await clickPlay(clients[0]);
    log.record('pause', 0);
    await untilS(TIMELINE.resumeAtS);
    await clickPlay(clients[0]);
    log.record('play', 0);
    console.log('[action] host paused/resumed');

    await untilS(s.durationS);
    log.record('scenario-end', -1);

    const { samples, pollFailures } = await collector.stop();
    console.log(`[collect] ${samples.length} samples, ${pollFailures} poll failures`);

    const { stats, pairwiseSeries } = computeStats(samples, log.events, N_CLIENTS);
    const meta: RunMeta = {
      runId,
      scenario: s,
      gitSha: sh('git rev-parse HEAD'),
      startedAt: new Date(scenarioStart).toISOString(),
      clients: N_CLIENTS,
      videoId: TEST_VIDEO_ID,
      wsUrl,
      hardware: `${hostname()} · ${process.arch} · node ${process.version}`,
      engine: ENGINE,
    };
    const dir = join(OUT_ROOT, runId);
    await writeRun(dir, meta, samples, log.events, stats, pairwiseSeries);
    console.log(
      `[done] ${s.id}: steady-state pairwise P50=${Math.round(stats.pairwiseSteadyState.p50 * 1000)}ms ` +
        `P95=${Math.round(stats.pairwiseSteadyState.p95 * 1000)}ms P99=${Math.round(stats.pairwiseSteadyState.p99 * 1000)}ms → ${dir}`,
    );
    return true;
  } finally {
    await browser.close().catch(() => {});
    await clearImpairment(s);
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error(`usage: npm run scenario -- S0[,S2,...]\navailable: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }
  const ids = arg.split(',').map((x) => x.trim());
  const results: Record<string, boolean> = {};
  for (const id of ids) {
    const s = SCENARIOS[id];
    if (!s) {
      console.error(`unknown scenario ${id}`);
      process.exit(1);
    }
    results[id] = await runScenario(s);
  }
  console.log('\n=== matrix result ===');
  for (const [id, ok] of Object.entries(results)) console.log(`${id}: ${ok ? 'ok' : 'FAILED'}`);
  if (!Object.values(results).every(Boolean)) process.exit(2);
}

void main();
