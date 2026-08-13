// Sliding sessions and credential changes, against a real server.
//
// Three flows that only mean anything with real tokens, real revocation
// state, and real time: refresh must ROTATE (the old token dies with the
// refresh, not on its own schedule); linking Google to a full account must
// be closed to a bearer token alone; and setting a password must end every
// other session while the caller's own continues.
//
// Usage: node scripts/live-checks/session-check.mjs [http://localhost:3007]
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
const decode = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());

// ---- an account with a password, and a second session beside it ----
const name = 'sess' + rnd();
const first = (
  await call('/auth/register', {
    body: { username: name, email: `${name}@example.com`, password: 'a-real-password' },
  })
).body;
ok('SETUP: an account', Boolean(first?.token));
const second = (
  await call('/auth/login', { body: { username: name, password: 'a-real-password' } })
).body;
ok('SETUP: a second session', Boolean(second?.token));

// ---- refresh: rotation ----
// a full second between mint and refresh, so a token that WRONGLY restamped
// its birth to 'now' would be caught by the equality below
await new Promise((r) => setTimeout(r, 1100));
const refreshed = await call('/auth/refresh', { token: first.token });
ok('refresh returns a new token', refreshed.status === 201 && Boolean(refreshed.body?.token));
const oldClaims = decode(first.token);
const newClaims = decode(refreshed.body.token);
ok('the new token carries a NEW jti', newClaims.jti && newClaims.jti !== oldClaims.jti);
ok('and preserves the session birth verbatim',
  Number.isFinite(oldClaims.sess) && Number.isFinite(newClaims.sess) &&
    newClaims.sess === oldClaims.sess,
  `${oldClaims.sess} -> ${newClaims.sess}`);

// the wait that makes the rotation check honest: the refresh revokes the
// old jti through the revocation snapshot, which the guard reads in memory
// on this same instance - immediate, no propagation needed
const oldAfter = await call('/auth/me', { method: 'GET', token: first.token });
ok('the OLD token is dead - rotation, not accumulation', oldAfter.status === 401,
  `status ${oldAfter.status}`);
ok('the new token works', (await call('/auth/me', { method: 'GET', token: refreshed.body.token })).status === 200);
ok('the second session is untouched by the rotation',
  (await call('/auth/me', { method: 'GET', token: second.token })).status === 200);

// ---- link-start gate ----
const wrongPw = await call('/auth/google/link-start', {
  body: { password: 'not-the-password' },
  token: refreshed.body.token,
});
// exactly 401: link-start verifies the password before google.start() can
// 404, so a wrong password is refused regardless of whether the provider is
// configured. Accepting 404 would let this pass in the default dev env
// without the gate ever running.
ok('linking with the wrong password is refused with 401',
  wrongPw.status === 401, `status ${wrongPw.status}`);

// ---- set-password: current-password gate, then the version bump ----
const wrongCurrent = await call('/auth/set-password', {
  body: { currentPassword: 'wrong', newPassword: 'another-password-1' },
  token: refreshed.body.token,
});
ok('changing the password demands the current one', wrongCurrent.status === 401);

const changed = await call('/auth/set-password', {
  body: { currentPassword: 'a-real-password', newPassword: 'another-password-1' },
  token: refreshed.body.token,
});
ok('the change succeeds with the current password', changed.status === 201,
  `status ${changed.status}`);
ok('every OTHER session is signed out by the change',
  (await call('/auth/me', { method: 'GET', token: second.token })).status === 401);
ok('the token that made the change is signed out too - superseded by the response',
  (await call('/auth/me', { method: 'GET', token: refreshed.body.token })).status === 401);
ok('the caller continues on the returned token',
  (await call('/auth/me', { method: 'GET', token: changed.body.token })).status === 200);
ok('the new password signs in; the old one does not',
  (await call('/auth/login', { body: { username: name, password: 'another-password-1' } })).status === 201 &&
  (await call('/auth/login', { body: { username: name, password: 'a-real-password' } })).status === 401);

// ---- the laundering the review found: a revoked token must not refresh ----
// sign out everywhere on the surviving token, then try to refresh a token
// that was valid a moment ago. The authoritative DB check must catch it even
// though (single instance) the snapshot is current - the point is that
// refresh does NOT trust the token's own claim to a fresh version.
const l1 = (await call('/auth/register', {
  body: { username: 'launder' + rnd(), email: `l${rnd()}@e.com`, password: 'a-real-password' },
})).body;
const l2 = (await call('/auth/login', {
  body: { username: decode(l1.token).name, password: 'a-real-password' },
})).body;
// The check is vacuous if l2 has no token: refresh with undefined sends no
// Authorization header, the guard 401s, and the assertion passes having
// laundered nothing. Assert the second session exists first.
ok('SETUP: a second session to launder exists', Boolean(l2?.token),
  `login status body: ${JSON.stringify(l2)?.slice(0, 80)}`);
// use l1 to sign out everywhere, then try to REFRESH l2 (older version)
await call('/auth/logout-all', { token: l1.token });
const laundered = await call('/auth/refresh', { token: l2?.token });
ok('a token from before logout-all cannot refresh itself back to life',
  laundered.status === 401, `status ${laundered.status}`);

// double-refresh of ONE token: the second is a reuse signal, must 401 AND
// the first token's family should be burned
const dr = (await call('/auth/register', {
  body: { username: 'dr' + rnd(), email: `d${rnd()}@e.com`, password: 'a-real-password' },
})).body;
const [a, b] = await Promise.all([
  call('/auth/refresh', { token: dr.token }),
  call('/auth/refresh', { token: dr.token }),
]);
const wins = [a, b].filter((r) => r.status === 201).length;
ok('concurrent double-refresh does not mint two live sessions',
  wins <= 1, `${wins} of 2 refreshes succeeded`);

// ---- refresh refuses what it must ----
const guest = (await call('/auth/guest')).body;
ok('SETUP: a guest', Boolean(guest?.token));
const guestRefresh = await call('/auth/refresh', { token: guest.token });
ok('a guest session refreshes too - guests are sessions like any other',
  guestRefresh.status === 201);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
