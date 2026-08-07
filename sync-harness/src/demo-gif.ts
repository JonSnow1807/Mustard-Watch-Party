// Records the README demo: two real Chrome windows in one room, the HUD's
// live drift readout visible, driven through the app's own UI (play, seek,
// pause, resume) - wait-for-broadcast sync on screen, no narration needed.
// Produces two per-window webm videos; the composing ffmpeg call lives in
// the runner script. Not a measurement tool: nothing here is published as a
// number, so it needs no run directory or provenance stamp.
//   npx tsx src/demo-gif.ts <outDir>
import { mkdirSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { createRoom, registerUser } from './app-api.js';

const OUT = process.argv[2] ?? '/tmp/demo-gif';
const FRONTEND = process.env.HARNESS_FRONTEND_URL ?? 'http://localhost:3001';
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const runId = `demo-${Date.now().toString(36)}`;
  const alice = await registerUser(runId, 0);
  const bob = await registerUser(runId, 1);
  // the same pinned CC video the measurement matrix uses
  const room = await createRoom(
    alice,
    runId,
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  );

  const browser: Browser = await chromium
    .launch({
      channel: 'chrome',
      headless: false,
      args: [
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    })
    .catch(() => chromium.launch({ headless: false }));

  const open = async (user: typeof alice) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 640 },
      recordVideo: { dir: OUT, size: { width: 640, height: 560 } },
    });
    await context.addInitScript((u) => {
      window.localStorage.setItem('user', JSON.stringify(u));
    }, user);
    const page = await context.newPage();
    await page.goto(`${FRONTEND}/room/${room.code}?debug=1`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(() => Boolean((window as any).__mustardSync), undefined, {
      timeout: 30000,
    });
    // joining can auto-scroll to the roster/chat; the recording must show
    // the player and the HUD, so pin the viewport to the top
    await page.evaluate(() => window.scrollTo(0, 0));
    return { context, page };
  };

  const a = await open(alice);
  const b = await open(bob);
  await sleep(4000); // both players cued, HUDs visible
  // re-pin after late layout/join side effects
  await a.page.evaluate(() => window.scrollTo(0, 0));
  await b.page.evaluate(() => window.scrollTo(0, 0));

  // Alice drives; Bob only watches - every transition below reaches his
  // window through the same sync:timeline broadcast Alice converges from.
  await a.page.getByTestId('play-button').first().click();
  await sleep(9000); // both playing, HUD drift settling to tens of ms

  // seek: click 60% into the progress bar
  const bar = a.page.getByTestId('progress-bar').first();
  const box = await bar.boundingBox();
  if (box) await a.page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
  await sleep(9000);

  await a.page.getByTestId('play-button').first().click(); // pause
  await sleep(4000);
  await a.page.getByTestId('play-button').first().click(); // resume
  await sleep(8000);

  await a.context.close(); // flushes the videos
  await b.context.close();
  await browser.close();
  console.log(`videos in ${OUT}`);
}

void main();
