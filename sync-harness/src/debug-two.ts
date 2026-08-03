// Two-client repro: host + follower through an arbitrary ws URL, with
// console capture, play click, and follower state polling.
import { registerUser, createRoom } from './app-api.js';
import { clickPlay, launchBrowser, openClient, waitForShim } from './browser.js';
import { TEST_VIDEO_URL } from './scenarios.js';

const wsUrl = process.argv[2] ?? 'ws://localhost:3000';
console.log('ws:', wsUrl);

const runId = `dbg2-${Date.now().toString(36)}`;
const users = await Promise.all([registerUser(runId, 0), registerUser(runId, 1)]);
const room = await createRoom(users[0], runId, TEST_VIDEO_URL);

const browser = await launchBrowser();
const clients = [];
for (let i = 0; i < 2; i++) {
  const c = await openClient(browser, i, users[i], room.code, wsUrl);
  c.page.on('console', (m) => console.log(`[c${i} ${m.type()}] ${m.text()}`));
  c.page.on('pageerror', (e) => console.log(`[c${i} pageerror] ${e.message}`));
  clients.push(c);
  await waitForShim(c);
  console.log(`client ${i} shim ready`);
}

await new Promise((r) => setTimeout(r, 3000));
console.log('--- host clicks play ---');
await clickPlay(clients[0]);

for (let t = 0; t < 12; t++) {
  await new Promise((r) => setTimeout(r, 1000));
  const states = await Promise.all(
    clients.map((c) =>
      c.page.evaluate(() => {
        const shim = (window as any).__mustardSync;
        const { samples } = shim.getSamplesSince(0);
        const last = samples[samples.length - 1];
        return last ? { st: last.playerState, pt: last.playerTime.toFixed(2) } : null;
      }),
    ),
  );
  console.log(`t+${t + 1}s`, JSON.stringify(states));
}
await browser.close();
