import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtService } from '@nestjs/jwt';
import type { RevocationService } from './revocation.service';

const jwtService = new JwtService({ secret: 'test-secret' });
import { GoogleOAuthService } from './google/google-oauth.service';

/** Just enough Response to see what the handler decided. */
const makeRes = () => {
  const res = {
    cookies: [] as { name: string; value: string }[],
    cleared: [] as string[],
    redirectedTo: undefined as string | undefined,
    cookie(name: string, value: string) {
      res.cookies.push({ name, value });
      return res;
    },
    clearCookie(name: string) {
      res.cleared.push(name);
      return res;
    },
    redirect(url: string) {
      res.redirectedTo = url;
    },
  };
  return res;
};

const makeGoogle = (enabled: boolean) => {
  const assertEnabled = () => {
    if (!enabled) throw new NotFoundException('not configured');
  };
  return {
    enabled,
    assertEnabled,
    // the real start() asserts internally before building anything, and a
    // double that skipped that would let the route look guarded when it
    // was only the double being polite
    start: () => {
      assertEnabled();
      return {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        cookie: 'sealed',
      };
    },
    verifyCallback: jest.fn(),
    callbackRedirect: (fragment: string) =>
      `https://mustard.watch/auth/callback#${fragment}`,
    redirectUri: 'https://api.mustard.watch/api/auth/google/callback',
  } as unknown as GoogleOAuthService;
};

/** Revoked nothing, which is what every test here but the logout ones assume. */
const noRevocations = () =>
  ({
    isRevoked: () => null,
    revokeToken: jest.fn().mockResolvedValue(undefined),
    revokeAllForUser: jest.fn().mockResolvedValue(2),
  }) as unknown as RevocationService;

const controllerWith = (enabled: boolean) =>
  new AuthController(
    { signInWithGoogle: jest.fn() } as unknown as AuthService,
    makeGoogle(enabled),
    noRevocations(),
    jwtService,
  );

const emptyReq = { headers: {} } as Request;

describe('the OAuth routes when the provider is off', () => {
  it('404s /google/start without touching the response', () => {
    const res = makeRes();
    expect(() =>
      controllerWith(false).start(undefined, res as unknown as Response),
    ).toThrow(NotFoundException);
    expect(res.redirectedTo).toBeUndefined();
    // no half-started flow left behind: a sealed cookie handed out by a
    // route that then 404s is a live CSRF/PKCE pair with nothing to redeem it
    expect(res.cookies).toHaveLength(0);
  });

  it('404s /google/callback without touching the response or calling Google', async () => {
    // The provider can be off BECAUSE the frontend origin is loopback. If
    // the callback still redirected on error, it would send the visitor to
    // that loopback address - the exact hazard the guard exists to stop.
    const res = makeRes();
    const controller = controllerWith(false);
    const verifyCallback = (
      controller as unknown as {
        google: { verifyCallback: jest.Mock };
      }
    ).google.verifyCallback;

    await expect(
      controller.callback(
        'c',
        's',
        undefined,
        emptyReq,
        res as unknown as Response,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(res.redirectedTo).toBeUndefined();
    // These two are the ordering, not decoration: assertEnabled() runs BEFORE
    // clearCookie and before any exchange, so a disabled route neither
    // mutates the caller's cookies nor spends a round trip to Google.
    expect(res.cleared).toHaveLength(0);
    expect(verifyCallback).not.toHaveBeenCalled();
  });
});

describe('the OAuth routes when the provider is on', () => {
  it('sets the sealed cookie and sends the browser to Google', () => {
    const res = makeRes();
    controllerWith(true).start(undefined, res as unknown as Response);

    expect(res.cookies[0].name).toBe('mw_oauth');
    expect(res.redirectedTo).toContain('accounts.google.com');
  });

  it('clears the cookie and reports a failure as a code in the fragment', async () => {
    const controller = controllerWith(true);
    const google = (controller as unknown as { google: GoogleOAuthService })
      .google;
    (google.verifyCallback as jest.Mock).mockRejectedValue(
      Object.assign(new Error('state'), { code: 'state' }),
    );

    const res = makeRes();
    await controller.callback(
      'c',
      'bad',
      undefined,
      emptyReq,
      res as unknown as Response,
    );

    // single use: cleared before anything can fail
    expect(res.cleared).toContain('mw_oauth');
    expect(res.redirectedTo).toBe(
      'https://mustard.watch/auth/callback#error=exchange',
    );
  });
});

describe('the guest route under two limits at once', () => {
  // Both buckets are real here. The point of these tests is the interaction
  // between them, which is where I got it wrong: a mocked bucket would have
  // agreed with either ordering.
  const guestController = () => {
    const createGuest = jest.fn().mockResolvedValue({
      id: 'u1',
      username: 'guest-1',
      email: 'x@guest.invalid',
      token: 't',
    });
    const controller = new AuthController(
      { createGuest } as unknown as AuthService,
      makeGoogle(false),
      noRevocations(),
      jwtService,
    );
    return { controller, createGuest };
  };

  // Under NODE_ENV=test there is no proxy to trust, so the key is the socket
  // peer and the header is ignored on purpose - which is itself the correct
  // behaviour, and why the peer varies here. How the chain is read when there
  // IS a proxy is pinned in rate-bucket.spec.ts; these tests are about what
  // the two buckets do to each other.
  const from = (ip: string) =>
    ({
      headers: { 'x-forwarded-for': `${ip}, 10.201.4.31` },
      socket: { remoteAddress: ip },
    }) as unknown as Request;

  const attempt = async (controller: AuthController, ip: string) => {
    try {
      await controller.guest(from(ip));
      return 201;
    } catch (err) {
      return (err as { getStatus(): number }).getStatus();
    }
  };

  it('allows one caller ten, then refuses them', async () => {
    const { controller } = guestController();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++)
      codes.push(await attempt(controller, '198.51.100.7'));
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it('does not let a refused caller spend the shared allowance', async () => {
    // The bug this pins: with the shared bucket asked FIRST, every one of
    // these ninety refusals still burned a token from it, so the caller
    // being blocked was draining the budget for everyone else on the way
    // down. Shared capacity is 300; the abuser should cost it exactly 10.
    const { controller } = guestController();
    for (let i = 0; i < 100; i++) await attempt(controller, '198.51.100.7');

    // 29 more callers × 10 each = 290, which with the abuser's 10 is exactly
    // the shared capacity. Every one of these must still be served.
    for (let caller = 0; caller < 29; caller++) {
      const codes: number[] = [];
      for (let i = 0; i < 10; i++) {
        codes.push(await attempt(controller, `203.0.113.${caller}`));
      }
      expect(codes).toEqual(Array(10).fill(201));
    }
  });

  it('does not charge a caller for a request the shared cap refused', async () => {
    // The mirror of the test above, and the half I missed: asking the
    // per-caller bucket first fixed one direction and broke the other.
    // Once the shared cap is empty, an honest caller's own ten must still
    // be intact - they were never served anything.
    const { controller } = guestController();
    for (let i = 0; i < 300; i++)
      await attempt(controller, `198.51.${Math.floor(i / 250)}.${i % 250}`);

    const fresh = '203.0.113.200';
    expect(await attempt(controller, fresh)).toBe(429); // shared cap, not theirs
    // more than their own capacity, so a version that spends before asking
    // leaves them empty rather than merely dented
    for (let i = 0; i < 15; i++) await attempt(controller, fresh);

    // their bucket is untouched, so when the shared cap refills they get
    // their full allowance rather than a spent one
    const bucket = (
      controller as unknown as {
        guestBucket: { peek(k: string, n: number): boolean };
      }
    ).guestBucket;
    expect(bucket.peek(fresh, Date.now())).toBe(true);
  });

  it('still stops a flood spread across many addresses', async () => {
    // What the per-caller bucket cannot see: 300 requests, every one from a
    // different address, none of them individually over the line.
    const { controller } = guestController();
    const codes: number[] = [];
    for (let i = 0; i < 310; i++) {
      codes.push(
        await attempt(controller, `198.51.${Math.floor(i / 250)}.${i % 250}`),
      );
    }
    expect(codes.filter((c) => c === 201)).toHaveLength(300);
    expect(codes.filter((c) => c === 429)).toHaveLength(10);
  });
});

describe('starting a link, which is a different thing from signing in', () => {
  const makeLinkGoogle = () => {
    const start = jest.fn().mockReturnValue({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
      cookie: 'sealed',
    });
    return {
      google: {
        enabled: true,
        assertEnabled: () => undefined,
        start,
        verifyCallback: jest.fn(),
        callbackRedirect: (f: string) =>
          `https://mustard.watch/auth/callback#${f}`,
        redirectUri: 'https://api.mustard.watch/api/auth/google/callback',
      } as unknown as GoogleOAuthService,
      start,
    };
  };

  it('seals the id the GUARD verified, not anything the caller sent', () => {
    // The whole security of linking rests here: a caller who could nominate
    // the account would be able to attach their Google identity to someone
    // else's.
    const { google, start } = makeLinkGoogle();
    const controller = new AuthController(
      {} as unknown as AuthService,
      google,
      noRevocations(),
      jwtService,
    );
    const res = makeRes();

    const out = controller.linkStart(
      'user-from-token',
      { returnTo: '/room/abc' },
      res as unknown as Response,
    );

    // cast the CALLS array, not the element - indexing an `any` array is
    // itself the unsafe access, which is the same note CodeRabbit left on
    // the claim tests
    const calls = start.mock.calls as [string | undefined, number, string][];
    expect(calls[0][2]).toBe('user-from-token');
    expect(out.authUrl).toContain('accounts.google.com');
    expect(res.cookies[0].name).toBe('mw_oauth');
  });

  it('returns the URL rather than redirecting to it', () => {
    // It is a POST carrying a bearer token, so the browser has to navigate
    // itself - a redirect here would be answered by fetch, not by the
    // address bar, and the flow would silently go nowhere.
    const { google } = makeLinkGoogle();
    const res = makeRes();
    new AuthController(
      {} as unknown as AuthService,
      google,
      noRevocations(),
      jwtService,
    ).linkStart('u1', {}, res as unknown as Response);
    expect(res.redirectedTo).toBeUndefined();
  });
});

describe('what the callback tells someone when it fails', () => {
  const callbackWith = (signInWithGoogle: jest.Mock) => {
    const google = {
      enabled: true,
      assertEnabled: () => undefined,
      start: jest.fn(),
      verifyCallback: jest.fn().mockResolvedValue({
        identity: { subject: 's', email: 'a@b.co', emailVerified: true },
      }),
      callbackRedirect: (f: string) =>
        `https://mustard.watch/auth/callback#${f}`,
      redirectUri: 'https://api.mustard.watch/api/auth/google/callback',
    } as unknown as GoogleOAuthService;
    const logger = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const controller = new AuthController(
      { signInWithGoogle } as unknown as AuthService,
      google,
      noRevocations(),
      jwtService,
    );
    return { controller, logger };
  };

  afterEach(() => jest.restoreAllMocks());

  it('reports a coded link refusal as that code, and does not log it', async () => {
    const { controller, logger } = callbackWith(
      jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'link_email_taken',
          message: 'An account with that email already exists',
        }),
      ),
    );
    const res = makeRes();
    await controller.callback(
      'c',
      's',
      undefined,
      emptyReq,
      res as unknown as Response,
    );

    expect(res.redirectedTo).toContain('error=link_email_taken');
    // nobody's bug, so nothing to alert on
    expect(logger).not.toHaveBeenCalled();
  });

  it('does NOT dress an uncoded conflict up as a link refusal', async () => {
    // createGoogleUser throws ConflictException with a plain string when it
    // runs out of username attempts - a sign-in, not a link. Reading the
    // CLASS rather than the code told that person their guest session was
    // untouched, when they had no guest session, and skipped the log that
    // would have shown a real allocation anomaly.
    const { controller, logger } = callbackWith(
      jest
        .fn()
        .mockRejectedValue(
          new ConflictException('Could not allocate a username'),
        ),
    );
    const res = makeRes();
    await controller.callback(
      'c',
      's',
      undefined,
      emptyReq,
      res as unknown as Response,
    );

    expect(res.redirectedTo).toContain('error=exchange');
    expect(res.redirectedTo).not.toContain('link');
    expect(logger).toHaveBeenCalled();
  });

  it('never puts a sentence in the fragment, only a code', async () => {
    // The channel is a redirect URL: the API does not know how the frontend
    // words things, and a code cannot leak anything about the account it
    // refused. An earlier version of mine sent the message text.
    const { controller } = callbackWith(
      jest.fn().mockRejectedValue(
        new ConflictException({
          code: 'link_provider_taken',
          message: 'That Google account is already signed in here',
        }),
      ),
    );
    const res = makeRes();
    await controller.callback(
      'c',
      's',
      undefined,
      emptyReq,
      res as unknown as Response,
    );

    expect(res.redirectedTo).not.toContain('already signed in');
    expect(res.redirectedTo).not.toContain('detail');
  });
});

describe('signing out', () => {
  const withRevocations = () => {
    const revocations = {
      isRevoked: () => null,
      revokeToken: jest.fn().mockResolvedValue(undefined),
      revokeAllForUser: jest.fn().mockResolvedValue(4),
    };
    const controller = new AuthController(
      {} as unknown as AuthService,
      makeGoogle(false),
      revocations as unknown as RevocationService,
      jwtService,
    );
    return { controller, revocations };
  };

  const bearing = (token: string) =>
    ({ headers: { authorization: `Bearer ${token}` } }) as Request;

  it('revokes the token the request arrived on', async () => {
    const { controller, revocations } = withRevocations();
    const token = jwtService.sign({ sub: 'u1', name: 'ada', jti: 'j1' });

    await expect(controller.logout(bearing(token))).resolves.toEqual({
      revoked: true,
    });

    const [jti, userId] = (
      revocations.revokeToken.mock.calls as [string, string, Date][]
    )[0];
    expect(jti).toBe('j1');
    expect(userId).toBe('u1');
  });

  it('says so honestly when the token cannot be revoked individually', async () => {
    // Tokens issued before jti existed carry none. Reporting success would
    // tell someone their session was ended when it was not.
    const { controller, revocations } = withRevocations();
    const token = jwtService.sign({ sub: 'u1', name: 'ada' });

    await expect(controller.logout(bearing(token))).resolves.toEqual({
      revoked: false,
    });
    expect(revocations.revokeToken).not.toHaveBeenCalled();
  });

  it('keeps the revocation record only as long as the token would have lived', async () => {
    const { controller, revocations } = withRevocations();
    const token = jwtService.sign(
      { sub: 'u1', name: 'ada', jti: 'j1' },
      { expiresIn: '1h' },
    );

    await controller.logout(bearing(token));

    const [, , expiresAt] = (
      revocations.revokeToken.mock.calls as [string, string, Date][]
    )[0];
    const hourAway = Date.now() + 3600_000;
    // within a minute of an hour from now, not 1970 - the exp claim is in
    // SECONDS and treating it as milliseconds would put it in the past
    expect(Math.abs(expiresAt.getTime() - hourAway)).toBeLessThan(60_000);
  });

  it('signs out everywhere by bumping the version, and reports it', async () => {
    const { controller, revocations } = withRevocations();
    await expect(controller.logoutAll('u1')).resolves.toEqual({ version: 4 });
    expect(revocations.revokeAllForUser).toHaveBeenCalledWith('u1');
  });
});
