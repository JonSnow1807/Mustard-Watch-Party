import { NotFoundException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
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

const controllerWith = (enabled: boolean) =>
  new AuthController(
    { signInWithGoogle: jest.fn() } as unknown as AuthService,
    makeGoogle(enabled),
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
