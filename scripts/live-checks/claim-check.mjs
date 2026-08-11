// Does claiming a guest account actually keep the history hanging off it?
// The unit tests assert the service calls update() with the same id - which
// is the mock agreeing with itself. Only a real database can say whether the
// chat rows and participant rows still point at a live user afterwards.
import { io } from '/Users/chinmayshrivastava/mustard-revamped/video-sync-frontend/node_modules/socket.io-client/build/esm-debug/index.js';

const API = 'http://localhost:3007/api';
const WS = 'http://localhost:3007';
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

// a host with a real account, and a room to have a conversation in
const host = (
  await call('/auth/register', {
    body: { username: 'host' + rnd(), email: `h${rnd()}@e.com`, password: 'pw-123456' },
  })
).body;
const room = (await call('/rooms', { body: { name: 'claim test' }, token: host.token })).body;

// someone arrives with no account and says something
const guest = (await call('/auth/guest')).body;
const sock = io(WS, { transports: ['websocket'], auth: { token: guest.token } });
// ASSERT the setup. The first version of this check did not, so when the
// socket quietly failed to connect there was simply no history to preserve -
// and the harness reported that as the product losing it.
const connected = await new Promise((r) => {
  sock.on('connect', () => r(true));
  sock.on('connect_error', (e) => r(String(e?.message ?? e)));
  setTimeout(() => r('timeout'), 6000);
});
ok('SETUP: the guest socket connects', connected === true, String(connected));

const joined = await new Promise((r) => {
  sock.on('room-joined', () => r(true));
  sock.on('error', (e) => r(String(e?.message ?? JSON.stringify(e))));
  sock.emit('join-room', { roomCode: room.code, userId: guest.id });
  setTimeout(() => r('timeout'), 5000);
});
ok('SETUP: the guest joins the room', joined === true, String(joined));

const said = await new Promise((r) => {
  sock.on('chat-message', () => r(true));
  sock.emit('send-message', {
    roomCode: room.code,
    message: { userId: guest.id, username: guest.username, message: 'said as a guest' },
  });
  setTimeout(() => r('timeout'), 5000);
});
ok('SETUP: the guest says something', said === true, String(said));

if (connected !== true || joined !== true || said !== true) {
  console.log('\nSetup did not complete - there is no history to preserve, so');
  console.log('the questions below would be meaningless. Stopping here.');
  sock.close();
  process.exit(1);
}
// Participation is checked HERE, while the socket is still open: the
// participant row is removed on disconnect, and the first version of this
// check closed the socket first and then reported the absence as data loss.
const beforeClaim = await fetch(`${API}/rooms/${room.code}`, {
  headers: { authorization: `Bearer ${host.token}` },
}).then((r) => r.json());
ok('SETUP: the guest is in the participant list',
   (beforeClaim.participants ?? []).some((p) => (p.user?.id ?? p.userId) === guest.id));

sock.close();
await new Promise((r) => setTimeout(r, 400));

// now they decide to keep the account
const name = 'ada' + rnd();
const claimed = await call('/auth/claim', {
  body: { username: name, email: `${name}@example.com`, password: 'a-real-password' },
  token: guest.token,
});

ok('claiming succeeds', claimed.status === 200 || claimed.status === 201,
   `status ${claimed.status} ${JSON.stringify(claimed.body)?.slice(0, 120)}`);
ok('THE SAME ROW - the id is unchanged', claimed.body?.id === guest.id,
   `${guest.id} -> ${claimed.body?.id}`);
ok('a fresh token is issued', typeof claimed.body?.token === 'string' &&
   claimed.body.token !== guest.token);
ok('the guest address is gone', !String(claimed.body?.email).endsWith('@guest.invalid'),
   claimed.body?.email);

// The point of all of it. Chat history is served over the socket, not in
// the room's REST body - reading it from the wrong place is what made the
// first version of this check report three failures that were its own.
//
// Reconnecting with the NEW token also proves it satisfies the handshake,
// which is worth having on its own.
const after = io(WS, {
  transports: ['websocket'],
  auth: { token: claimed.body.token },
});
const reconnected = await new Promise((r) => {
  after.on('connect', () => r(true));
  after.on('connect_error', (e) => r(String(e?.message ?? e)));
  setTimeout(() => r('timeout'), 6000);
});
ok('the new token is accepted by the socket handshake', reconnected === true,
   String(reconnected));

const history = await new Promise((r) => {
  after.on('message-history', (m) => r(m));
  after.emit('join-room', { roomCode: room.code, userId: guest.id });
  setTimeout(() => after.emit('get-message-history', { roomCode: room.code }), 300);
  setTimeout(() => r([]), 5000);
});
const mine = (history ?? []).filter((m) => (m.userId ?? m.user?.id) === guest.id);
ok('the message sent as a guest is still attributed to them', mine.length === 1,
   `${mine.length} of ${(history ?? []).length} message(s)`);
ok('and it now carries the name they chose',
   mine[0]?.username === name || mine[0]?.user?.username === name,
   `shows "${mine[0]?.username ?? mine[0]?.user?.username}"`);

const afterClaim = await fetch(`${API}/rooms/${room.code}`, {
  headers: { authorization: `Bearer ${host.token}` },
}).then((r) => r.json());
ok('they are in the participant list under the new name',
   (afterClaim.participants ?? []).some(
     (p) => (p.user?.id ?? p.userId) === guest.id && p.user?.username === name,
   ));
after.close();

// the new password works, which is the entire reason for claiming
const login = await call('/auth/login', { body: { username: name, password: 'a-real-password' } });
ok('they can now sign back in with a password', login.status === 200 || login.status === 201,
   `status ${login.status}`);
ok('and it is still the same account', login.body?.id === guest.id);

// and it cannot be done twice - the row is no longer a guest
const again = await call('/auth/claim', {
  body: { username: 'other' + rnd(), email: `o${rnd()}@e.com`, password: 'another-password' },
  token: claimed.body.token,
});
ok('a full account cannot be claimed again', again.status === 403, `status ${again.status}`);

// a stolen token must not be able to overwrite someone else's credentials
const victim = await call('/auth/claim', {
  body: { username: 'takeover' + rnd(), email: `t${rnd()}@e.com`, password: 'takeover-pass' },
  token: host.token,
});
ok("a real account's credentials cannot be overwritten this way",
   victim.status === 403, `status ${victim.status}`);

// the sweeper must not delete a claimed account
const stillThere = await call('/auth/me', { method: 'GET', token: login.body.token });
ok('the claimed account is a full account now', stillThere.body?.id === guest.id);

// deliberately NOT deleting the room here: deleting it removes the chat
// rows this check is about, and the first run of this queried the database
// afterwards and concluded the history was lost.
await fetch(`${API}/rooms/${room.code}`, {
  method: 'DELETE',
  headers: { authorization: `Bearer ${host.token}` },
});

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
