// One instrumented client for debugging harness runs: dumps console
// messages, final URL, player iframe presence, and a screenshot.
import { registerUser, createRoom } from './app-api.js';
import { launchBrowser, openClient } from './browser.js';
import { TEST_VIDEO_URL } from './scenarios.js';

const user = await registerUser(`dbg-${Date.now().toString(36)}`, 0);
const room = await createRoom(user, 'debug', TEST_VIDEO_URL);
console.log('room:', room.code, 'user:', user.username, 'id:', user.id);

const browser = await launchBrowser();
const logs: string[] = [];
const client = await openClient(browser, 0, user, room.code, 'ws://localhost:3000');
client.page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
client.page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await new Promise((r) => setTimeout(r, 15000));

console.log('final url:', client.page.url());
console.log('shim present:', await client.page.evaluate(() => Boolean((window as any).__mustardSync)));
console.log('yt iframe:', await client.page.evaluate(() => document.querySelector('#youtube-player')?.tagName ?? 'none'));
console.log('localStorage.user:', await client.page.evaluate(() => window.localStorage.getItem('user')));
console.log('--- console ---');
for (const l of logs.slice(0, 40)) console.log(l);
await client.page.screenshot({ path: 'runs/debug.png' });
console.log('screenshot: runs/debug.png');
await browser.close();
