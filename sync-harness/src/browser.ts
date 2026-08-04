import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { HarnessUser } from './app-api.js';
import type { ActionEvent, CollectedSample, ShimSample } from './types.js';

const FRONTEND = process.env.HARNESS_FRONTEND_URL ?? 'http://localhost:3001';

// Headed Chrome with throttling disabled: background-tab timer throttling
// would corrupt sampling, and this is a measurement rig, not a stealth rig.
const LAUNCH_ARGS = [
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--window-size=520,420',
];

export interface HarnessClient {
  index: number;
  user: HarnessUser;
  context: BrowserContext;
  page: Page;
}

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ channel: 'chrome', headless: false, args: LAUNCH_ARGS });
  } catch {
    return await chromium.launch({ headless: false, args: LAUNCH_ARGS });
  }
}

export async function openClient(
  browser: Browser,
  index: number,
  user: HarnessUser,
  roomCode: string,
  wsUrl: string,
  controller: 'reactive' | 'predictive' = 'predictive',
): Promise<HarnessClient> {
  const context = await browser.newContext({ viewport: { width: 500, height: 400 } });
  // AuthContext reads localStorage.user; seeding it skips the login UI so
  // joins are deterministic and fast.
  await context.addInitScript((u) => {
    window.localStorage.setItem('user', JSON.stringify(u));
  }, user);
  const page = await context.newPage();
  const arm = controller === 'reactive' ? '&controller=R' : '';
  const url = `${FRONTEND}/room/${roomCode}?ws=${encodeURIComponent(wsUrl)}${arm}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { index, user, context, page };
}

/** The shim only appears once the player fired onReady. */
export async function waitForShim(client: HarnessClient, timeoutMs = 30000): Promise<void> {
  await client.page.waitForFunction(
    () => Boolean((window as any).__mustardSync),
    undefined,
    { timeout: timeoutMs },
  );
}

/**
 * Player health check: after the controller pressed play, every client must
 * reach PLAYING (state 1) within the deadline or the run is invalid (consent
 * walls, ads and bot interstitials all fail this check rather than silently
 * skewing the data).
 */
export async function waitForPlaying(client: HarnessClient, timeoutMs = 15000): Promise<boolean> {
  try {
    await client.page.waitForFunction(
      () => {
        const shim = (window as any).__mustardSync;
        if (!shim) return false;
        const { next, samples } = shim.getSamplesSince(0);
        const last = samples[samples.length - 1];
        return next > 0 && last?.playerState === 1;
      },
      undefined,
      { timeout: timeoutMs, polling: 250 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function clickPlay(client: HarnessClient): Promise<void> {
  await client.page.getByTestId('play-button').click();
}

export async function clickSeek(client: HarnessClient, fraction: number): Promise<void> {
  const bar = client.page.getByTestId('progress-bar');
  const box = await bar.boundingBox();
  if (!box) throw new Error('progress bar not visible');
  await client.page.mouse.click(box.x + box.width * fraction, box.y + box.height / 2);
}

export class Collector {
  private cursors: number[] = [];
  private samples: CollectedSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private failures = 0;
  /** guards against overlapping drains: cursors advance only after the
   * awaited page.evaluate returns, so a second concurrent drain would
   * re-read the same window and duplicate samples in the published data */
  private draining = false;

  constructor(private clients: HarnessClient[]) {
    this.cursors = clients.map(() => 0);
  }

  start(intervalMs = 250): void {
    this.timer = setInterval(() => {
      void this.drainAll();
    }, intervalMs);
  }

  private inFlight: Promise<void> | null = null;

  private drainAll(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.drainOnce().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async drainOnce(): Promise<void> {
    await Promise.all(
      this.clients.map(async (c, i) => {
        try {
          const result = (await c.page.evaluate((cursor) => {
            const shim = (window as any).__mustardSync;
            return shim ? shim.getSamplesSince(cursor) : null;
          }, this.cursors[i])) as { next: number; samples: ShimSample[] } | null;
          if (!result) return;
          this.cursors[i] = result.next;
          for (const s of result.samples) {
            this.samples.push({ ...s, client: i });
          }
        } catch {
          this.failures += 1;
        }
      }),
    );
  }

  async stop(): Promise<{ samples: CollectedSample[]; pollFailures: number }> {
    if (this.timer) clearInterval(this.timer);
    // wait out any in-flight drain, THEN drain once more, so the tail of the
    // run is never lost to the overlap guard
    await this.drainAll();
    await this.drainAll();
    return { samples: this.samples, pollFailures: this.failures };
  }
}

export class ActionLog {
  events: ActionEvent[] = [];
  record(kind: ActionEvent['kind'], client: number, detail?: string): void {
    this.events.push({ tHost: Date.now(), client, kind, detail });
  }
}
