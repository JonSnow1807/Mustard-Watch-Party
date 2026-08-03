// Socket-level proofs for the M3 backend engine gate:
//   1. unauthenticated sockets are rejected
//   2. forged identity cannot control (payload userIds are ignored)
//   3. non-controllers are rejected on sync:control
//   4. sync:clock ack carries causally-ordered stamps
//   5. mid-play joiners receive a projected timeline, not a stale scalar
//   6. control floods are rate-limited
// Run: npx tsx src/verify-m3.ts   (backend on :3000 with fresh build)
import { io, type Socket } from 'socket.io-client';
import { createRoom, registerUser, type HarnessUser } from './app-api.js';

const WS = 'http://localhost:3000';
const runId = `m3-${Date.now().toString(36)}`;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function connect(token?: string): Promise<{ socket: Socket; error?: string }> {
  return new Promise((resolve) => {
    const socket = io(WS, {
      transports: ['websocket'],
      auth: token ? { token } : {},
      reconnection: false,
      timeout: 5000,
    });
    socket.on('connect', () => resolve({ socket }));
    socket.on('connect_error', (err) => resolve({ socket, error: err.message }));
  });
}

function joinRoom(socket: Socket, roomCode: string, claimedUserId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('join timeout')), 5000);
    socket.once('room-joined', (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`join error: ${JSON.stringify(err)}`));
    });
    socket.emit('join-room', { roomCode, userId: claimedUserId });
  });
}

function once<T>(socket: Socket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timeout`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---------- fixtures ----------
const creator: HarnessUser & { token?: string } = await registerUser(runId, 0);
const guest: HarnessUser & { token?: string } = await registerUser(runId, 1);
const late: HarnessUser & { token?: string } = await registerUser(runId, 2);
const room = await createRoom(creator, runId, 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');

// 1. unauthenticated rejected
{
  const { error } = await connect(undefined);
  check('unauthenticated socket rejected', Boolean(error?.includes('unauthorized')), error);
}
{
  const { error } = await connect('garbage-token');
  check('invalid token rejected', Boolean(error?.includes('unauthorized')), error);
}

// 2 + 3. forged identity / non-controller rejected on both paths
const creatorSock = (await connect(creator.token)).socket;
const guestSock = (await connect(guest.token)).socket;
await joinRoom(creatorSock, room.code, creator.id);
// the guest CLAIMS to be the creator in the join payload — must be ignored
await joinRoom(guestSock, room.code, creator.id);

{
  const rejected = once<{ reason: string }>(guestSock, 'sync:control-rejected');
  guestSock.emit('sync:control', { v: 1, roomCode: room.code, intent: 'play', mediaTime: 0 });
  const result = await rejected.catch((e) => ({ reason: `no-rejection: ${e.message}` }));
  check('forged-identity sync:control rejected', result.reason === 'not-controller', result.reason);
}
{
  const legacyErr = once<{ message: string }>(guestSock, 'error');
  guestSock.emit('video-state', {
    roomCode: room.code,
    state: { currentTime: 999, isPlaying: true },
    action: 'play',
  });
  const result = await legacyErr.catch((e) => ({ message: `no-error: ${e.message}` }));
  check(
    'forged-identity legacy video-state rejected',
    result.message.includes('Only the host'),
    result.message,
  );
}

// 4. clock ack stamps
{
  const t0 = Date.now();
  const pong = await new Promise<{ t0: number; t1: number; t2: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('clock ack timeout')), 4000);
    creatorSock.emit('sync:clock', { t0 }, (resp: { t0: number; t1: number; t2: number }) => {
      clearTimeout(timer);
      resolve(resp);
    });
  });
  const t3 = Date.now();
  const causal = pong.t0 === t0 && pong.t1 <= pong.t2 && t3 - t0 >= pong.t2 - pong.t1;
  check('sync:clock ack causally ordered', causal, JSON.stringify({ ...pong, t3 }));
}

// 5. mid-play join projection
{
  const broadcast = once<{ seq: number; mediaTime: number; isPlaying: boolean }>(
    creatorSock,
    'sync:timeline',
  );
  creatorSock.emit('sync:control', { v: 1, roomCode: room.code, intent: 'play', mediaTime: 100 });
  const tl = await broadcast;
  check('control broadcast reaches the commander too', tl.isPlaying && tl.mediaTime === 100);

  await sleep(3000);
  const lateSock = (await connect(late.token)).socket;
  const joined = await joinRoom(lateSock, room.code, late.id);
  const projected = joined.timeline as { mediaTime: number; stampedAt: number; isPlaying: boolean };
  // server projects at join... the joiner receives mediaTime@stampedAt; with
  // ~3s elapsed the projection at now is ~103
  const projectedNow =
    projected.mediaTime + (projected.isPlaying ? (Date.now() - projected.stampedAt) / 1000 : 0);
  check(
    'mid-play joiner gets projected timeline (~103s, not the stale 100)',
    Math.abs(projectedNow - 103) < 1.5,
    `projectedNow=${projectedNow.toFixed(2)}`,
  );
  lateSock.disconnect();
}

// 6. rate limit
{
  let rejectedCount = 0;
  guestSock.removeAllListeners('sync:control-rejected');
  creatorSock.on('sync:control-rejected', (r: { reason: string }) => {
    if (r.reason === 'rate-limited') rejectedCount += 1;
  });
  for (let i = 0; i < 25; i++) {
    creatorSock.emit('sync:control', { v: 1, roomCode: room.code, intent: 'play', mediaTime: i });
  }
  await sleep(1500);
  check('control flood rate-limited', rejectedCount > 0, `${rejectedCount} rejected of 25`);
}

creatorSock.disconnect();
guestSock.disconnect();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
