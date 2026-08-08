// Repro instrumentation for the file-arm S0 anomaly: three staggered
// browser clients plus a node-side socket TAP in the same room printing every
// sync:timeline broadcast (seq, reason, by, isPlaying, mediaTime) and every
// rejection - so whatever control turns the room off is caught in the act.
//   HARNESS_VIDEO_URL=/media/clicktrack.mp4 npx tsx src/debug-pause.ts
import { io } from 'socket.io-client';
import { registerUser, createRoom } from './app-api.js';
import { clickPlay, launchBrowser, openClient, waitForShim } from './browser.js';
import { TEST_VIDEO_URL } from './scenarios.js';

const runId = `dbgp-${Date.now().toString(36)}`;
const users = await Promise.all([
  registerUser(runId, 0),
  registerUser(runId, 1),
  registerUser(runId, 2),
  registerUser(runId, 3), // the tap
]);
const room = await createRoom(users[0], runId, TEST_VIDEO_URL);
console.log('room:', room.code, 'video:', TEST_VIDEO_URL);

// ---- node tap: joins the room over socket.io and just listens ----
const t0 = Date.now();
const ts = (): string => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
const tap = io('ws://localhost:3000', {
  transports: ['websocket'],
  auth: { token: users[3].token },
});
// bounded: a diagnostic that hangs before the clients even start would
// itself need diagnosing
await new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(
    () => reject(new Error('tap connect deadline (15s)')),
    15_000,
  );
  tap.on('connect', () => {
    clearTimeout(deadline);
    resolve();
  });
  tap.on('connect_error', (e: Error) => {
    clearTimeout(deadline);
    reject(e);
  });
});
tap.emit('join-room', { roomCode: room.code, userId: users[3].id });
tap.on('sync:timeline', (tl: Record<string, unknown>) => {
  console.log(
    `${ts()}s TL seq=${tl.seq} reason=${tl.reason} playing=${tl.isPlaying} mt=${Number(tl.mediaTime).toFixed(2)} by=${tl.by ?? '-'}`,
  );
});
tap.on('sync:control-rejected', (r: Record<string, unknown>) =>
  console.log(`${ts()}s REJECTED ${r.intent}: ${r.reason}`),
);
tap.on('room:controller', (c: Record<string, unknown>) =>
  console.log(`${ts()}s CONTROLLER ${c.controllerId} (${c.reason})`),
);
tap.on('disconnect', (reason: string) =>
  console.log(`${ts()}s TAP DISCONNECTED: ${reason}`),
);
tap.io.on('reconnect', () => console.log(`${ts()}s TAP reconnected`));

// ---- three real clients, staggered like the scripted scenario ----
const browser = await launchBrowser();
const clients = [];
const joinAt = [0, 5, 10];
const started = Date.now();
for (let i = 0; i < 3; i++) {
  const wait = started + joinAt[i] * 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const c = await openClient(browser, i, users[i], room.code, 'ws://localhost:3000');
  c.page.on('console', (m) => {
    const text = m.text();
    if (!text.includes('[HMR]')) console.log(`${ts()}s [c${i} ${m.type()}] ${text}`);
  });
  c.page.on('pageerror', (e) => console.log(`${ts()}s [c${i} pageerror] ${e.message}`));
  clients.push(c);
  await waitForShim(c);
  console.log(`${ts()}s client ${i} shim ready`);
}

await new Promise((r) => setTimeout(r, 10000));
console.log(`${ts()}s --- host clicks play ---`);
await clickPlay(clients[0]);

for (let t = 0; t < 110; t++) {
  await new Promise((r) => setTimeout(r, 1000));
  const states = await Promise.all(
    clients.map((c) =>
      c.page.evaluate(() => {
        const shim = (window as { __mustardSync?: { getSamplesSince(n: number): { samples: Array<{ playerState: number; playerTime: number }> } } }).__mustardSync;
        const { samples } = shim!.getSamplesSince(0);
        const last = samples[samples.length - 1];
        return last ? `st=${last.playerState} pt=${last.playerTime.toFixed(2)}` : 'none';
      }),
    ),
  );
  if (t % 5 === 0) {
    console.log(`${ts()}s players: c0[${states[0]}] c1[${states[1]}] c2[${states[2]}]`);
  }
}

await browser.close();
tap.disconnect();
