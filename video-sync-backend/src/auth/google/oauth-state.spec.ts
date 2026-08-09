import { createHmac } from 'crypto';
import * as jwt from 'jsonwebtoken';
import { openState, randomToken, safeEqual, sealState } from './oauth-state';

const SECRET = 'test-secret';
const NOW = 1_700_000_000_000;

const payload = (over: Partial<Parameters<typeof sealState>[0]> = {}) => ({
  state: 'the-state',
  codeVerifier: 'the-verifier',
  returnTo: '/room/abc',
  expiresAt: NOW + 60_000,
  ...over,
});

describe('sealed OAuth state', () => {
  it('round-trips a live flow', () => {
    const opened = openState(sealState(payload(), SECRET), SECRET, NOW);
    expect(opened).toMatchObject({
      state: 'the-state',
      codeVerifier: 'the-verifier',
      returnTo: '/room/abc',
    });
  });

  it('refuses a seal signed with a different secret', () => {
    // what a redeploy with a rotated JWT_SECRET looks like, and also what
    // an attacker who guesses the format but not the key looks like
    const sealed = sealState(payload(), 'other-secret');
    expect(openState(sealed, SECRET, NOW)).toBeNull();
  });

  it('refuses a tampered body', () => {
    const sealed = sealState(payload(), SECRET);
    const [body, sig] = sealed.split('.');
    const forged = Buffer.from(
      JSON.stringify(payload({ state: 'attacker-state' })),
      'utf8',
    ).toString('base64url');
    expect(openState(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
    // and the original still opens, so the test is testing the tampering
    expect(openState(`${body}.${sig}`, SECRET, NOW)).not.toBeNull();
  });

  it('refuses an expired flow', () => {
    const sealed = sealState(payload({ expiresAt: NOW }), SECRET);
    expect(openState(sealed, SECRET, NOW)).toBeNull();
    expect(openState(sealed, SECRET, NOW - 1)).not.toBeNull();
  });

  it.each([
    ['nothing', undefined],
    ['an empty string', ''],
    ['no separator', 'abcdef'],
    ['an empty body', '.sig'],
    ['a non-JSON body', `${Buffer.from('nope').toString('base64url')}.sig`],
  ])('refuses %s', (_name, value) => {
    expect(openState(value, SECRET, NOW)).toBeNull();
  });

  it('refuses a correctly signed body that is not JSON', () => {
    // Every malformed case above dies at the signature check, so none of
    // them reaches the parse. Reaching it needs a VALID signature over
    // garbage, which means signing the way production does.
    const signLikeProduction = (body: string) =>
      createHmac(
        'sha256',
        createHmac('sha256', SECRET).update('mustard:oauth-state:v1').digest(),
      )
        .update(body)
        .digest('base64url');

    // Control: the same signing must produce a seal that DOES open. Without
    // this, a drift in the derivation would make the assertion below pass
    // for the wrong reason - rejected at the signature, parse never run.
    const goodBody = Buffer.from(JSON.stringify(payload()), 'utf8').toString(
      'base64url',
    );
    expect(
      openState(`${goodBody}.${signLikeProduction(goodBody)}`, SECRET, NOW),
    ).not.toBeNull();

    const garbage = Buffer.from('{not json at all', 'utf8').toString(
      'base64url',
    );
    expect(
      openState(`${garbage}.${signLikeProduction(garbage)}`, SECRET, NOW),
    ).toBeNull();
  });

  it('refuses a seal missing the fields the callback depends on', () => {
    const sealed = sealState(
      { state: 's', expiresAt: NOW + 1000 } as never,
      SECRET,
    );
    expect(openState(sealed, SECRET, NOW)).toBeNull();
  });

  // The point of deriving a separate key: the two things we sign with the
  // same secret must not be interchangeable in either direction.
  it('is not an access token, and an access token is not a seal', () => {
    const sealed = sealState(payload(), SECRET);
    expect(() => jwt.verify(sealed, SECRET)).toThrow();

    const token = jwt.sign({ sub: 'u1', name: 'someone' }, SECRET);
    expect(openState(token, SECRET, NOW)).toBeNull();
  });
});

describe('safeEqual', () => {
  it('compares without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('randomToken', () => {
  it('is URL-safe and long enough to be a CSRF value', () => {
    const token = randomToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(randomToken()).not.toBe(token);
  });
});
