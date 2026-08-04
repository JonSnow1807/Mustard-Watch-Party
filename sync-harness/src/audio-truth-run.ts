// M10: audio ground truth. Three real browsers play a same-origin click
// track under the sync engine; each page reports the page-clock instant at
// which each click physically left its audio graph. Cross-client comparison
// of those instants is a sync measurement that never consults a player clock.
//
//   npx tsx src/audio-truth-run.ts
import { execSync } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRoom, registerUser } from './app-api.js';
import { clickPlay, launchBrowser, openClient, type HarnessClient } from './browser.js';
import { percentile } from './stats.js';

const CLIENTS = 3;
const RUN_S = 150;
const MEDIA = '/media/clicktrack.mp4';
/** clicks inside this window after playback starts are join/settle
 * transients, not steady state - the same exclusion every other scenario
 * in this harness applies (sync-harness/README.md) */
const WARMUP_S = 15;
/** a client that heard far fewer clicks than its peers was not really
 * playing; reporting its pairs as sync data would be a lie */
const MIN_COVERAGE = 0.8;

interface Onset {
  index: number;
  tLocal: number;
  playerTime: number;
  level: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const runId = `audio-${Date.now().toString(36)}`;
  const users = await Promise.all(
    Array.from({ length: CLIENTS }, (_, i) => registerUser(runId, i)),
  );
  const room = await createRoom(users[0], runId, MEDIA);
  const browser = await launchBrowser();
  const clients: HarnessClient[] = [];
  try {
    for (let i = 0; i < CLIENTS; i++) {
      clients.push(
        await openClient(browser, i, users[i], room.code, 'ws://localhost:3000'),
      );
      await sleep(1500);
    }
    // the probe only exists once the media element mounted
    for (const c of clients) {
      await c.page.waitForFunction(() => Boolean((window as any).__mustardAudio), undefined, {
        timeout: 20000,
      });
    }
    console.log('[audio] probes ready; starting playback');
    const playAt = Date.now();
    await clickPlay(clients[0]);
    await sleep(RUN_S * 1000);

    const perClient: Onset[][] = [];
    for (const c of clients) {
      const onsets = (await c.page.evaluate(() =>
        (window as any).__mustardAudio.getOnsets(),
      )) as Onset[];
      perClient.push(onsets);
      console.log(`[audio] client ${c.index}: ${onsets.length} onsets`);
    }
    const meta = (await clients[0].page.evaluate(() => {
      const a = (window as any).__mustardAudio;
      return { sampleRate: a.sampleRate, baseLatency: a.baseLatency, outputLatency: a.outputLatency };
    })) as Record<string, unknown>;

    // pair up clicks by index and diff the PHYSICAL onset instants
    const steadyFrom = playAt + WARMUP_S * 1000;
    const byIndex: Array<Map<number, Onset>> = perClient.map((list) => {
      const m = new Map<number, Onset>();
      for (const o of list) {
        if (o.level > 0.08 && o.tLocal >= steadyFrom) m.set(o.index, o);
      }
      return m;
    });
    const counts = byIndex.map((m) => m.size);
    const best = Math.max(...counts);
    // Per-client counts are not enough: three clients could each hear plenty
    // of clicks with little OVERLAP, and only shared clicks can be paired.
    // Coverage is therefore the intersection against the richest client.
    const shared = [...byIndex[0].keys()].filter((k) =>
      byIndex.every((m) => m.has(k)),
    ).length;
    const thin = counts.filter((c) => c < best * MIN_COVERAGE).length;
    if (best === 0 || thin > 0 || shared < best * MIN_COVERAGE) {
      console.error(
        `[audio] INVALID: per-client coverage ${counts.join('/')}, shared ` +
          `${shared} - clients were not playing the same steady stretch. ` +
          `Refusing to publish a sync number from it.`,
      );
      process.exitCode = 2;
    }
    const audioSkews: number[] = [];
    const apiSkews: number[] = [];
    const paired: Array<{ index: number; pair: string; audioMs: number; apiMs: number }> = [];
    for (let i = 0; i < CLIENTS; i++) {
      for (let j = i + 1; j < CLIENTS; j++) {
        for (const [index, a] of byIndex[i]) {
          const b = byIndex[j].get(index);
          if (!b) continue;
          // TRUTH: same physical click, difference of page-clock instants
          const audioMs = Math.abs(a.tLocal - b.tLocal);
          // what the player clocks claimed at those same instants
          const apiMs = Math.abs((a.playerTime - b.playerTime) * 1000);
          audioSkews.push(audioMs);
          apiSkews.push(apiMs);
          paired.push({ index, pair: `${i}-${j}`, audioMs, apiMs });
        }
      }
    }
    const sortedA = [...audioSkews].sort((x, y) => x - y);
    const sortedP = [...apiSkews].sort((x, y) => x - y);
    const residuals = paired.map((p) => p.audioMs - p.apiMs);
    const sortedR = [...residuals].map(Math.abs).sort((x, y) => x - y);
    const summary = {
      runId,
      clients: CLIENTS,
      durationS: RUN_S,
      warmupExcludedS: WARMUP_S,
      clickCoverage: counts,
      sharedClicks: shared,
      valid: best > 0 && thin === 0 && shared >= best * MIN_COVERAGE,
      pairedClicks: paired.length,
      audioTruthMs: {
        p50: percentile(sortedA, 50),
        p95: percentile(sortedA, 95),
        max: sortedA[sortedA.length - 1],
      },
      playerApiMs: {
        p50: percentile(sortedP, 50),
        p95: percentile(sortedP, 95),
      },
      calibrationResidualMs: {
        p50: percentile(sortedR, 50),
        p95: percentile(sortedR, 95),
      },
      audioMeta: meta,
      gitSha: execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim(),
      hardware: `${hostname()} · ${process.arch}`,
    };
    const dir = join(process.cwd(), 'runs', runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
    writeFileSync(
      join(dir, 'paired.ndjson'),
      paired.map((p) => JSON.stringify(p)).join('\n'),
    );
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

void main();
