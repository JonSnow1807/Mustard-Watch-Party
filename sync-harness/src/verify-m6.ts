// Multi-instance proofs against the lab (docker-compose.lab.yml):
//   1. split-brain: join via instance A, control via instance B -> converge
//   2. concurrent-control blast from different instances -> unique,
//      monotonically increasing seq (the Lua script is the serializer)
//   3. kill -9 one instance mid-playback -> its clients reconnect through
//      nginx to survivors and converge with the SAME storeEpoch (no reset)
//   4. instance clock domain: sync:clock acks from different instances map
//      to one clock (offset spread across instances < 50ms)
// Run: npx tsx src/verify-m6.ts   (lab up; REST via nginx :3300)
import { execSync } from 'node:child_process';
import { io, type Socket } from 'socket.io-client';
import type { ClockPong, Timeline } from '../../shared/sync-protocol';
import { SYNC_EVENTS } from '../../shared/sync-protocol';

const NGINX = 'http://localhost:3300';
const B = ['http://localhost:3301', 'http://localhost:3302', 'http://localhost:3303'];
const runId = `m6-${Date.now().toString(36)}`;
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function post<T>(base: string, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface User {
  id: string;
  username: string;
  token: string;
}

async function register(i: number): Promise<User> {
  const username = `harness-${runId}-${i}`;
  return post<User>(NGINX, '/auth/register', {
    username,
    email: `${username}@harness.invalid`,
    password: `pw-${runId}`,
  });
}

function connect(base: string, user: User): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = io(base, {
      transports: ['websocket'],
      auth: { token: user.token },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
    });
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function join(s: Socket, roomCode: string, userId: string): Promise<{ timeline: Timeline }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('join timeout')), 8000);
    s.once('room-joined', (p: { timeline: Timeline }) => {
      clearTimeout(t);
      resolve(p);
    });
    s.emit('join-room', { roomCode, userId });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ---- fixtures: users on distinct instances ----
const users = await Promise.all([register(0), register(1), register(2)]);
const room = await post<{ code: string }>(NGINX, '/rooms', {
  name: `lab ${runId}`,
  videoUrl: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  userId: users[0].id,
});

const sockA = await connect(B[0], users[0]); // creator on instance 1
const sockB = await connect(B[1], users[1]); // follower on instance 2
const sockC = await connect(NGINX, users[2]); // follower via nginx

await join(sockA, room.code, users[0].id);
const joinedB = await join(sockB, room.code, users[1].id);
await join(sockC, room.code, users[2].id);
const epoch0 = joinedB.timeline.storeEpoch;

// 1. split-brain: control issued on A must reach B and C (cross-instance)
{
  const gotB = new Promise<Timeline>((resolve) => sockB.once(SYNC_EVENTS.timeline, resolve));
  const gotC = new Promise<Timeline>((resolve) => sockC.once(SYNC_EVENTS.timeline, resolve));
  sockA.emit(SYNC_EVENTS.control, { v: 1, roomCode: room.code, intent: 'play', mediaTime: 50 });
  const [tlB, tlC] = await Promise.all([
    Promise.race([gotB, sleep(5000).then(() => null)]),
    Promise.race([gotC, sleep(5000).then(() => null)]),
  ]);
  check(
    'cross-instance fanout (A controls, B+C converge)',
    tlB?.mediaTime === 50 && tlC?.mediaTime === 50 && tlB.isPlaying === true,
    JSON.stringify({ b: tlB?.mediaTime, c: tlC?.mediaTime }),
  );
}

// 2. concurrent-control blast from two instances -> unique monotone seq
{
  const seqs: number[] = [];
  const collect = (tl: Timeline): void => {
    seqs.push(tl.seq);
  };
  sockC.on(SYNC_EVENTS.timeline, collect);
  for (let i = 0; i < 8; i++) {
    // guests can't control; the creator's socket is on A. Use A for half the
    // blast and A-via-second-socket... control requires permission, so blast
    // from the creator connected to TWO instances simultaneously.
    void i;
  }
  const sockA2 = await connect(B[2], users[0]); // creator's second socket on instance 3
  await join(sockA2, room.code, users[0].id);
  for (let i = 0; i < 5; i++) {
    sockA.emit(SYNC_EVENTS.control, { v: 1, roomCode: room.code, intent: 'seek', mediaTime: 100 + i });
    sockA2.emit(SYNC_EVENTS.control, { v: 1, roomCode: room.code, intent: 'seek', mediaTime: 200 + i });
  }
  await sleep(3000);
  sockC.off(SYNC_EVENTS.timeline, collect);
  const relevant = seqs.filter((x) => x > 1);
  const uniques = new Set(relevant);
  const monotone = relevant.every((x, i) => i === 0 || x > relevant[i - 1]);
  check(
    'concurrent controls from 2 instances serialize (unique monotone seq)',
    uniques.size === relevant.length && monotone && relevant.length >= 10,
    `${relevant.length} broadcasts, ${uniques.size} unique, monotone=${monotone}`,
  );
  sockA2.disconnect();
}

// 3. clock domain: acks from all three instances agree
{
  const offsets: number[] = [];
  for (const [i, base] of B.entries()) {
    const s = i === 0 ? sockA : i === 1 ? sockB : await connect(B[2], users[2]);
    const t0 = Date.now();
    const pong = await new Promise<ClockPong>((resolve) =>
      s.emit(SYNC_EVENTS.clock, { t0 }, resolve),
    );
    const t3 = Date.now();
    offsets.push((pong.t1 - t0 + (pong.t2 - t3)) / 2);
    if (i === 2) s.disconnect();
    void base;
  }
  const spread = Math.max(...offsets) - Math.min(...offsets);
  check(
    'one clock domain across instances (ack offset spread < 50ms)',
    spread < 50,
    `offsets=[${offsets.map((o) => o.toFixed(1)).join(', ')}] spread=${spread.toFixed(1)}ms`,
  );
}

// 4. kill -9 an instance mid-playback: clients reconnect, same storeEpoch
{
  // find which container sockB's instance is (b2 -> compose service backend2)
  execSync('docker compose -f ../docker-compose.lab.yml kill backend2', { stdio: 'ignore' });
  // sockB was on :3302 (dead); a real client would reconnect through the
  // load balancer - model that with a fresh socket via nginx
  sockB.disconnect();
  const sockB2 = await connect(NGINX, users[1]);
  const rejoined = await join(sockB2, room.code, users[1].id).catch(() => null);
  sockB2.disconnect();
  check(
    'kill -9 survivor rejoin keeps the timeline (same storeEpoch, no reset)',
    rejoined !== null && rejoined.timeline.storeEpoch === epoch0 && rejoined.timeline.isPlaying,
    rejoined ? `epoch ${rejoined.timeline.storeEpoch} === ${epoch0}` : 'rejoin failed',
  );
  execSync('docker compose -f ../docker-compose.lab.yml start backend2', { stdio: 'ignore' });
}

sockA.disconnect();
sockB.disconnect();
sockC.disconnect();
console.log(failures === 0 ? '\nALL M6 CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures === 0 ? 0 : 1);
