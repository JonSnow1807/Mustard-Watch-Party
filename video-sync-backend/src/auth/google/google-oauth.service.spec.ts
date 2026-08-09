import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleAuthError,
  GoogleOAuthService,
  safeReturnTo,
} from './google-oauth.service';
import { openState } from './oauth-state';

const SECRET = 'test-secret';

const configured: Record<string, string> = {
  'google.clientId': 'client-id.apps.googleusercontent.com',
  'google.clientSecret': 'client-secret',
  'jwt.secret': SECRET,
  publicApiUrl: 'https://api.mustard.watch',
  'cors.origin': 'https://mustard.watch,https://preview.vercel.app',
};

const serviceWith = (values: Record<string, string>) =>
  new GoogleOAuthService({
    get: (key: string) => values[key],
  } as unknown as ConfigService);

describe('GoogleOAuthService configuration', () => {
  it('is enabled only with both halves of the credential', () => {
    expect(serviceWith(configured).enabled).toBe(true);
    expect(serviceWith({ ...configured, 'google.clientId': '' }).enabled).toBe(
      false,
    );
    expect(
      serviceWith({ ...configured, 'google.clientSecret': '' }).enabled,
    ).toBe(false);
  });

  it('404s rather than 500s when unconfigured', () => {
    const service = serviceWith({ ...configured, 'google.clientId': '' });
    expect(() => service.start(undefined)).toThrow(NotFoundException);
  });

  it('builds the exact redirect URI registered with Google', () => {
    // this string has to match the console entry character for character -
    // a trailing slash or a missing /api is a redirect_uri_mismatch
    expect(serviceWith(configured).redirectUri).toBe(
      'https://api.mustard.watch/api/auth/google/callback',
    );
  });

  it('sends people back to the canonical site, not a preview origin', () => {
    // FRONTEND_URL is a comma-separated CORS allowlist; only the first entry
    // is the real site, and a token must never be handed to the others
    expect(serviceWith(configured).frontendUrl).toBe('https://mustard.watch');
    expect(serviceWith(configured).callbackRedirect('token=t')).toBe(
      'https://mustard.watch/auth/callback#token=t',
    );
  });
});

describe('GoogleOAuthService.start', () => {
  const service = serviceWith(configured);

  it('asks for an identity and nothing else, with PKCE', () => {
    const { authUrl } = service.start(undefined);
    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(service.redirectUri);
    // no refresh token we would then have to store
    expect(url.searchParams.get('access_type')).toBe('online');
  });

  it('keeps the verifier in the cookie and only its hash in the URL', () => {
    const { authUrl, cookie } = service.start(undefined);
    const opened = openState(cookie, SECRET, Date.now());
    const challenge = new URL(authUrl).searchParams.get('code_challenge');

    expect(opened?.codeVerifier).toBeTruthy();
    expect(authUrl).not.toContain(opened!.codeVerifier);
    expect(challenge).not.toBe(opened!.codeVerifier);
    // the state in the URL is the state we will demand back
    expect(new URL(authUrl).searchParams.get('state')).toBe(opened!.state);
  });

  it('draws a fresh state and verifier every time', () => {
    const a = openState(service.start(undefined).cookie, SECRET, Date.now());
    const b = openState(service.start(undefined).cookie, SECRET, Date.now());
    expect(a!.state).not.toBe(b!.state);
    expect(a!.codeVerifier).not.toBe(b!.codeVerifier);
  });

  it('carries a safe returnTo and drops a hostile one', () => {
    const good = openState(
      service.start('/room/abc').cookie,
      SECRET,
      Date.now(),
    );
    expect(good?.returnTo).toBe('/room/abc');

    const bad = openState(
      service.start('https://evil.example/steal').cookie,
      SECRET,
      Date.now(),
    );
    expect(bad?.returnTo).toBeUndefined();
  });
});

describe('GoogleOAuthService.verifyCallback', () => {
  const service = serviceWith(configured);

  const expectFailure = async (
    params: Parameters<GoogleOAuthService['verifyCallback']>[0],
    code: string,
  ) => {
    await expect(service.verifyCallback(params)).rejects.toMatchObject({
      code,
    });
    await expect(service.verifyCallback(params)).rejects.toBeInstanceOf(
      GoogleAuthError,
    );
  };

  it('reports a declined consent screen as denied', async () => {
    await expectFailure({ error: 'access_denied' }, 'denied');
  });

  it('refuses a callback with no cookie - the login-CSRF case', async () => {
    // an attacker who gets a victim to load a callback URL carrying the
    // ATTACKER's code would sign the victim into the attacker's account;
    // the cookie is what makes that impossible
    await expectFailure({ code: 'c', state: 's' }, 'state');
  });

  it('refuses a state that does not match the cookie', async () => {
    const { cookie } = service.start(undefined);
    await expectFailure({ code: 'c', state: 'not-it', cookie }, 'state');
  });

  it('refuses a cookie from an expired flow', async () => {
    const { authUrl, cookie } = service.start(undefined, 0);
    const state = new URL(authUrl).searchParams.get('state')!;
    await expectFailure(
      { code: 'c', state, cookie, now: 11 * 60 * 1000 },
      'state',
    );
  });

  it('refuses a matching state with no code', async () => {
    const { authUrl, cookie } = service.start(undefined);
    const state = new URL(authUrl).searchParams.get('state')!;
    await expectFailure({ state, cookie }, 'exchange');
  });
});

describe('safeReturnTo', () => {
  it('keeps a path on our own site', () => {
    expect(safeReturnTo('/room/abc')).toBe('/room/abc');
    expect(safeReturnTo('/')).toBe('/');
  });

  it.each([
    ['an absolute URL', 'https://evil.example/'],
    ['a protocol-relative URL', '//evil.example/'],
    ['a scheme', 'javascript:alert(1)'],
    ['a bare path', 'room/abc'],
    ['a backslash trick', '/\\evil.example'],
    ['a CRLF header injection', '/room\r\nSet-Cookie: a=b'],
    ['nothing', undefined],
    ['an empty string', ''],
  ])('drops %s', (_name, value) => {
    expect(safeReturnTo(value)).toBeUndefined();
  });

  it('caps the length', () => {
    expect(safeReturnTo(`/${'a'.repeat(1000)}`)).toHaveLength(512);
  });
});
