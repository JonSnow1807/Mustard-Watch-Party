// The bug the conformance suite could not see: revocation enforced only on
// EGRESS. A revoked client that ignores the server's Close frame and keeps
// sending Control frames must be STOPPED - it must not keep mutating Redis
// and broadcasting to the room. relay-go closes the socket, which ends its
// read loop; relay-rs must do the same via the close-signal on the read path,
// plus the ingress revocation gate.
//
// Usage: node scripts/live-checks/relay-ingress-check.mjs [ws-port]
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sync-harness', 'package.json'),
);
const WebSocket = require('ws');
const Redis = require('ioredis');
const jwt = createRequire(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'video-sync-backend', 'package.json'),
)('jsonwebtoken');

const PORT = Number(process.argv[2] ?? 3505);
const SECRET = process.env.JWT_SECRET ?? 'conformance-secret';
const REDIS_URL = 'redis://localhost:6380';
const redis = new Redis(REDIS_URL);

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${label}${extra ? ' - ' + extra : ''}`);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mint = (claims) => jwt.sign({ name: 'ingress', ...claims }, SECRET, { expiresIn: '1h' });

const room = 'ingressroom' + Math.random().toString(36).slice(2, 8);
const controlFrame = (mediaTime, cmdId) => {
  const r = Buffer.from(room);
  const c = Buffer.from(cmdId);
  const b = Buffer.alloc(12 + r.length + c.length);
  b.writeUInt8(0x03, 0);
  b.writeUInt8(2, 1); // seek
  b.writeDoubleLE(mediaTime, 2);
  b.writeUInt8(r.length, 10);
  r.copy(b, 11);
  b.writeUInt8(c.length, 11 + r.length);
  c.copy(b, 12 + r.length);
  return b;
};

await redis.del('revoked:jti', 'revoked:userver');

// an attacker's connection that will IGNORE the server's Close frame and keep
// sending. `ws` with no close handler stays open on the client side even after
// the server sends Close, until the socket is actually torn down.
const token = mint({ sub: 'attacker', jti: 'jATT', ver: 0 });
const attacker = new WebSocket(`ws://localhost:${PORT}/sync?token=${token}`);
attacker.binaryType = 'nodebuffer';
let socketClosed = false;
attacker.on('close', () => (socketClosed = true));
const opened = await new Promise((r) => {
  attacker.on('open', () => r(true));
  attacker.on('error', () => r(false));
  setTimeout(() => r('timeout'), 4000);
});
ok('SETUP: attacker connects and joins', opened === true);
if (opened !== true) {
  // nothing below can mean anything without a live attacker socket, and the
  // asserts would fire against a dead connection and mislead
  await redis.del('revoked:jti', 'revoked:userver');
  redis.disconnect();
  try { attacker.terminate(); } catch { /* never opened */ }
  console.log('\n1 FAILED (attacker did not connect)');
  process.exit(1);
}
// join the room
const joinFrame = Buffer.alloc(2 + Buffer.from(room).length);
joinFrame.writeUInt8(0x05, 0);
joinFrame.writeUInt8(Buffer.from(room).length, 1);
Buffer.from(room).copy(joinFrame, 2);
attacker.send(joinFrame);
await sleep(300);

// it can drive the room while trusted
attacker.send(controlFrame(100, 'cmd-before'));
await sleep(300);
const before = await redis.hget(`room:${room}:tl`, 'mediaTime');
ok('SETUP: a trusted control commits', Number(before) === 100, `mediaTime=${before}`);

// now REVOKE the attacker's token and announce it
await redis.sadd('revoked:jti', 'jATT');
await redis.publish('mustard:revocations', JSON.stringify({ kind: 'token', jti: 'jATT' }));
await sleep(500);

// the attacker ignores the Close and keeps sending. The ingress gate + the
// close-signal ending the read loop must make these commands NOT commit.
for (let i = 0; i < 10; i++) {
  try {
    attacker.send(controlFrame(999, `cmd-after-${i}`));
  } catch {
    // socket may be torn down mid-loop, which is the point
  }
  await sleep(50);
}
await sleep(500);

const after = await redis.hget(`room:${room}:tl`, 'mediaTime');
ok('a revoked client cannot keep driving the room (ingress gated)',
  Number(after) === 100, `mediaTime after revocation attempts=${after} (want 100)`);
ok('the revoked socket was actually closed, not just told to close',
  socketClosed, `client-observed close=${socketClosed}`);

try { attacker.terminate(); } catch { /* already gone */ }
await redis.del('revoked:jti', 'revoked:userver', `room:${room}:tl`, `room:${room}:log`);
redis.disconnect();
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
