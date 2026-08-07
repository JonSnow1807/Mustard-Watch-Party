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

  // no Chromium fallback: the artifact's claim is "two real Chrome
  // clients", so a machine without Chrome must fail the recording, not
  // quietly produce a different one
  const browser: Browser = await chromium.launch({
    channel: 'chrome',
    headless: false,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const contexts: import('playwright').BrowserContext[] = [];
  // Recording starts when a CONTEXT is created, and the two videos are
  // aligned in post by their own t=0 - so the contexts must be created
  // back-to-back, and every slow step (page load, join, HUD render) must
  // run in parallel afterwards. The first cut of this script opened the
  // windows sequentially, which time-shifted the composite by several
  // seconds and made perfectly-synced players LOOK seconds apart.
  const makeContext = async (user: typeof alice) => {
    const context = await browser.newContext({
      viewport: { width: 640, height: 640 },
      recordVideo: { dir: OUT, size: { width: 640, height: 640 } },
    });
    contexts.push(context);
    await context.addInitScript((u) => {
      window.localStorage.setItem('user', JSON.stringify(u));
    }, user);
    return context;
  };
  const setupPage = async (context: import('playwright').BrowserContext) => {
    const page = await context.newPage();
    await page.goto(`${FRONTEND}/room/${room.code}?debug=1`, {
      waitUntil: 'domcontentloaded',
    });
    // the shim existing does not mean the HUD has rendered - wait for the
    // overlay the recording exists to show
    await page.getByTestId('sync-hud').waitFor({ state: 'visible', timeout: 30000 });
    // joining can auto-scroll to the roster/chat; the recording must show
    // the player and the HUD, so pin the viewport to the top
    await page.evaluate(() => window.scrollTo(0, 0));
    return page;
  };

  /**
   * Both pages flash a small corner marker at the SAME host wall-clock
   * instant (both browsers run on this machine, so Date.now() is one
   * physical clock). The composition step finds the flash in each video
   * and aligns on it - sub-frame ground truth instead of trusting the two
   * recordings to have started together. The marker sits in the bottom
   *-right corner and is cropped out of the published composite.
   */
  const scheduleFlash = (page: import('playwright').Page, atMs: number) =>
    page.evaluate((t) => {
      const d = document.createElement('div');
      d.id = '__demo_sync_marker';
      Object.assign(d.style, {
        position: 'fixed',
        right: '0',
        bottom: '0',
        width: '24px',
        height: '24px',
        background: '#000',
        zIndex: '99999',
      });
      document.body.appendChild(d);
      setTimeout(() => {
        d.style.background = '#ff0040';
        setTimeout(() => {
          d.style.background = '#000';
        }, 800);
      }, Math.max(0, t - Date.now()));
    }, atMs);

  try {
    const ctxA = await makeContext(alice);
    const ctxB = await makeContext(bob); // milliseconds after A, not seconds
    const [pageA, pageB] = await Promise.all([setupPage(ctxA), setupPage(ctxB)]);
    const a = { context: ctxA, page: pageA };
    const b = { context: ctxB, page: pageB };

    const flashAt = Date.now() + 1500;
    await Promise.all([scheduleFlash(a.page, flashAt), scheduleFlash(b.page, flashAt)]);
    await sleep(4000); // flash lands here; both players cued, HUDs visible
    // re-pin after late layout/join side effects
    await a.page.evaluate(() => window.scrollTo(0, 0));
    await b.page.evaluate(() => window.scrollTo(0, 0));

    // Alice drives; Bob only watches - every transition below reaches his
    // window through the same sync:timeline broadcast Alice converges from.
    await a.page.getByTestId('play-button').first().click();
    await sleep(9000); // both playing, HUD drift settling to tens of ms

    // seek: click 60% into the progress bar. A missing bar is a failed
    // recording, not a skippable step - a demo without the seek transition
    // silently records a different demo.
    const bar = a.page.getByTestId('progress-bar').first();
    const box = await bar.boundingBox();
    if (!box) throw new Error('progress bar not visible; seek is required');
    await a.page.mouse.click(box.x + box.width * 0.6, box.y + box.height / 2);
    await sleep(9000);

    await a.page.getByTestId('play-button').first().click(); // pause
    await sleep(4000);
    await a.page.getByTestId('play-button').first().click(); // resume
    await sleep(8000);
  } finally {
    // context.close() is what flushes recorded videos - it must run on the
    // failure path too, or a crashed take leaves nothing to inspect
    for (const c of contexts) {
      await c.close().catch(() => undefined);
    }
    await browser.close().catch(() => undefined);
  }
  console.log(`videos in ${OUT}`);
}

void main();
