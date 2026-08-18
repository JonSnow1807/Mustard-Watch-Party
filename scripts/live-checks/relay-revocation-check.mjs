// Does the RELAY actually stop trusting a revoked token - at accept, and on
// the connection it already accepted?
//
// The relay verifies the same tokens as the Node planes but had no view of
// revocation at all: a valid signature was a permanent pass. This drives a
// real relay against a real Redis with real binary-protocol websockets,
// because every piece of this - the mirror keys, the pub/sub fanout, the
// eviction path, the accept-time check - crosses a process boundary no unit
// test reaches. The relay eviction path in particular has a known hazard
// (closing c.send from outside the handler panics the process), so the
// check watches the relay STAY ALIVE after evicting as deliberately as it
// watches the connection die.
//
// Usage: node scripts/live-checks/relay-revocation-check.mjs
//   needs: redis on localhost:6380 (docker compose -f docker-compose.lab.yml up -d redis)
//          go toolchain

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const requireHarness = createRequire(join(repo, 'sync-harness', 'package.json'));
const requireBackend = createRequire(join(repo, 'video-sync-backend', 'package.json'));
const WebSocket = requireHarness('ws');
const jwt = requireBackend('jsonwebtoken');
const Redis = requireHarness('ioredis');

const SECRET = 'relay-live-check-secret';
const PORT = Number(process.env.RELAY_PORT ?? 3401);
const PREBUILT = process.env.RELAY_BIN; // set to run a non-Go relay binary
const REDIS_URL = 'redis://localhost:6380';

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${label}${extra ? ' - ' + extra : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mint = (claims, expiresIn = '1h') =>
  jwt.sign({ name: 'live-check', ...claims }, SECRET, { expiresIn });

/** Open a relay connection; resolve {ws, closed} where closed resolves with the close code. */
const connect = (token) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/sync?token=${token}`);
  const opened = new Promise((resolve) => {
    ws.on('open', () => resolve(true));
    ws.on('error', () => resolve(false));
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    setTimeout(() => resolve('timeout'), 5000);
  });
  const closed = new Promise((resolve) => {
    ws.on('close', (code) => resolve(code));
  });
  return { ws, opened, closed };
};

const joinRoom = (ws, room) => {
  const frame = Buffer.alloc(2 + room.length);
  frame.writeUInt8(0x05, 0);
  frame.writeUInt8(room.length, 1);
  Buffer.from(room).copy(frame, 2);
  ws.send(frame);
  return new Promise((resolve) => {
    const onMsg = (buf) => {
      if (Buffer.from(buf).readUInt8(0) === 0x06) {
        ws.off('message', onMsg);
        resolve(true);
      }
    };
    ws.on('message', onMsg);
    setTimeout(() => resolve(false), 2000);
  });
};

const redis = new Redis(REDIS_URL);
// a previous aborted run must not leak revocations into this one
await redis.del('revoked:jti', 'revoked:userver');

let binary = PREBUILT;
if (!binary) {
  console.log('building relay-go...');
  const build = spawn('go', ['build', '-o', '/tmp/relay-live-check', '.'], {
    cwd: join(repo, 'relay-go'),
    stdio: 'inherit',
  });
  await new Promise((r, j) => build.on('exit', (c) => (c === 0 ? r() : j(new Error('go build failed')))));
  binary = '/tmp/relay-live-check';
}

const relay = spawn(
  binary,
  ['-addr', `:${PORT}`, '-redis', REDIS_URL, '-lua-dir', join(repo, 'video-sync-backend', 'src', 'sync', 'lua'), '-jwt-secret', SECRET],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let relayLog = '';
relay.stdout.on('data', (d) => (relayLog += d));
relay.stderr.on('data', (d) => (relayLog += d));
const relayDied = new Promise((r) => relay.on('exit', (code) => r(code)));
await sleep(1200);

try {
  // -- baseline: two sessions for one user, one for another --
  const tokenA = mint({ sub: 'u1', jti: 'jA', ver: 0 });
  const tokenB = mint({ sub: 'u1', jti: 'jB', ver: 0 });
  const a = connect(tokenA);
  const b = connect(tokenB);
  ok('SETUP: both sessions connect', (await a.opened) === true && (await b.opened) === true);
  ok('SETUP: a joins a room', await joinRoom(a.ws, 'livecheckroom'));

  // -- rooms that would alias other Redis keyspaces are refused --
  ok('a room containing ":" is ignored, not spliced into keys',
    !(await joinRoom(b.ws, 'a:b:tl')));
  ok('the same connection still joins a VALID room after the refusal',
    await joinRoom(b.ws, 'livecheckroom'));

  // -- revoke ONE session: the backend's exact writes --
  await redis.sadd('revoked:jti', 'jA');
  await redis.publish('mustard:revocations', JSON.stringify({ kind: 'token', jti: 'jA' }));

  const aClose = await Promise.race([a.closed, sleep(4000).then(() => 'still open')]);
  ok('the revoked session is closed within a round trip', aClose !== 'still open',
    `close code ${aClose}`);
  ok('the sibling session survives', b.ws.readyState === WebSocket.OPEN);

  // -- the revoked token cannot open a NEW connection --
  const again = connect(tokenA);
  ok('a revoked token is refused at accept', (await again.opened) === 401,
    `got ${await again.opened}`);
  again.ws.terminate();

  // -- sign out everywhere: version bump --
  await redis.hset('revoked:userver', 'u1', '1');
  await redis.publish('mustard:revocations', JSON.stringify({ kind: 'user', userId: 'u1', version: 1 }));
  const bClose = await Promise.race([b.closed, sleep(4000).then(() => 'still open')]);
  ok('every stale session of the user is closed', bClose !== 'still open');

  // -- but a token AT the new version connects: the strictly-less rule --
  const fresh = connect(mint({ sub: 'u1', jti: 'jNew', ver: 1 }));
  ok('the post-signout session is admitted', (await fresh.opened) === true);
  await sleep(500);
  ok('and stays up through the events above', fresh.ws.readyState === WebSocket.OPEN);
  fresh.ws.close();

  // -- tokens the relay must refuse on shape alone --
  const noExp = connect(jwt.sign({ sub: 'u9', name: 'x' }, SECRET)); // no expiresIn
  ok('a token with no exp is refused - it would never age out here',
    (await noExp.opened) === 401, `got ${await noExp.opened}`);
  const noSub = connect(mint({ jti: 'jX' }));
  ok('a subject-less token is refused, matching the Node plane',
    (await noSub.opened) === 401, `got ${await noSub.opened}`);

  // -- expiry: the sweep must close a connection whose token ran out --
  console.log('  (waiting ~35s for the expiry sweep - the token dies at +20s, the sweep runs every 30s)');
  const dying = connect(mint({ sub: 'u3', jti: 'jE', ver: 0 }, '20s'));
  ok('SETUP: the soon-to-expire session connects', (await dying.opened) === true);
  const dyingClose = await Promise.race([dying.closed, sleep(36000).then(() => 'still open')]);
  ok('the sweep closes a connection whose token expired', dyingClose !== 'still open',
    `close code ${dyingClose}`);

  // -- the hazard this file exists for: the relay must SURVIVE its evictions --
  const alive = await Promise.race([relayDied, Promise.resolve('alive')]);
  ok('the relay process survived every eviction (no close(c.send) panic)',
    alive === 'alive', `exit ${alive}\n${relayLog.slice(-300)}`);
} finally {
  relay.kill();
  await redis.del('revoked:jti', 'revoked:userver');
  redis.disconnect();
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
