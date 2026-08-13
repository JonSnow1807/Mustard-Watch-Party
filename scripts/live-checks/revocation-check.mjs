// Does signing out actually stop the token - including the socket that was
// already open?
//
// This is the half that unit tests cannot reach. Revocation crosses three
// planes that were each built to be independent: the REST guard, the socket
// handshake, and a connection that was authenticated once and then trusted
// for as long as it stayed open. The last of those is the reason this
// feature existed to be built, and a mock cannot tell you whether a real
// socket got closed.
//
// Usage: node scripts/live-checks/revocation-check.mjs [http://localhost:3007]
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'video-sync-frontend',
    'package.json',
  ),
);
const { io } = require('socket.io-client');

const BASE = (process.argv[2] ?? 'http://localhost:3007').replace(/\/$/, '');
const API = `${BASE}/api`;
const rnd = () => Math.random().toString(36).slice(2, 8);

const call = async (path, { method = 'POST', body, token } = {}) => {
  const r = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

let failed = 0;
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS ' : 'FAIL '} ${label}${extra ? ' - ' + extra : ''}`);
  if (!cond) failed++;
};

const connect = (token) => {
  const socket = io(BASE, { transports: ['websocket'], auth: { token } });
  const opened = new Promise((r) => {
    socket.on('connect', () => r(true));
    socket.on('connect_error', (e) => r(String(e?.message ?? e)));
    setTimeout(() => r('timeout'), 8000);
  });
  return { socket, opened };
};

// two sessions for the same person: a phone and a laptop
const name = 'revoke' + rnd();
const account = (
  await call('/auth/register', {
    body: { username: name, email: `${name}@example.com`, password: 'a-real-password' },
  })
).body;
ok('SETUP: an account', Boolean(account?.token), account?.username);
if (!account?.token) process.exit(1);

const second = (
  await call('/auth/login', { body: { username: name, password: 'a-real-password' } })
).body;
ok('SETUP: a second session for the same person', Boolean(second?.token));

// both tokens work over REST, and both open sockets
ok(
  'both sessions work before anything is revoked',
  (await call('/auth/me', { method: 'GET', token: account.token })).status === 200 &&
    (await call('/auth/me', { method: 'GET', token: second.token })).status === 200,
);

const first = connect(account.token);
const other = connect(second.token);
ok('SETUP: both sockets connect', (await first.opened) === true && (await other.opened) === true);

// the socket must be told, not just dropped: a silent disconnect is
// indistinguishable from a blip and the client retries forever
const ended = new Promise((r) => {
  first.socket.on('session-ended', (m) => r(m?.reason ?? 'no reason'));
  setTimeout(() => r(null), 8000);
});

// sign out ONE session
const out = await call('/auth/logout', { token: account.token });
ok('signing out reports that it revoked something', out.body?.revoked === true,
   `status ${out.status} ${JSON.stringify(out.body)}`);

const meAfter = await call('/auth/me', { method: 'GET', token: account.token });
ok('the signed-out token is refused over REST', meAfter.status === 401,
   `status ${meAfter.status}`);

ok('and the OTHER session is untouched',
   (await call('/auth/me', { method: 'GET', token: second.token })).status === 200);

const reason = await ended;
ok('the live socket was told why it is closing', reason === 'session signed out',
   String(reason));

await new Promise((r) => setTimeout(r, 400));
ok('and it is actually closed', first.socket.connected === false);
ok('while the other socket stays up', other.socket.connected === true);

// a revoked token must not be able to open a NEW socket either
const rejoin = connect(account.token);
const rejoined = await rejoin.opened;
ok('a signed-out token cannot open a new socket', rejoined !== true, String(rejoined));
rejoin.socket.close();

// now sign out EVERYWHERE, from the surviving session
const allEnded = new Promise((r) => {
  other.socket.on('session-ended', (m) => r(m?.reason ?? 'no reason'));
  setTimeout(() => r(null), 8000);
});
const all = await call('/auth/logout-all', { token: second.token });
ok('signing out everywhere bumps the version', typeof all.body?.version === 'number',
   JSON.stringify(all.body));

ok('the session that did it is refused too',
   (await call('/auth/me', { method: 'GET', token: second.token })).status === 401);

ok('its socket is told as well', (await allEnded) === 'signed out everywhere',
   String(await allEnded));

// and signing in again works, at the new version - the bug this would
// otherwise hide is a fresh token being born already revoked
const back = await call('/auth/login', {
  body: { username: name, password: 'a-real-password' },
});
const backToken = back.body?.token;
ok('signing in again gives a token that WORKS', Boolean(backToken) &&
   (await call('/auth/me', { method: 'GET', token: backToken })).status === 200,
   'a new token issued at the old version would be refused instantly');

// Guarded, because a check that throws here takes the summary and the socket
// cleanup with it - every result above would be lost to a TypeError about
// the one thing that failed.
if (backToken) {
  const backSocket = connect(backToken);
  ok('and it opens a socket', (await backSocket.opened) === true);
  backSocket.socket.close();
} else {
  ok('and it opens a socket', false, 'no token to try with');
}
other.socket.close();
first.socket.close();

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
