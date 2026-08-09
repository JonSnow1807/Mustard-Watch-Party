import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleAuthError,
  GoogleOAuthService,
  isLoopback,
  safeReturnTo,
} from './google-oauth.service';
import { openState } from './oauth-state';
import { OAuth2Client } from 'google-auth-library';

/** Only the two calls that leave the process are faked. */
interface FakeClient {
  generateAuthUrl: (opts: object) => string;
  getToken: jest.Mock;
  verifyIdToken: jest.Mock;
}

// Stand in for the calls that would reach Google. Everything below the state
// check is otherwise untestable without the network, and the branches down
// there include a security control (email_verified). generateAuthUrl stays
// REAL so the URL assertions above still test the library's output.
jest.mock('google-auth-library', () => {
  const actual = jest.requireActual<typeof import('google-auth-library')>(
    'google-auth-library',
  );
  return {
    ...actual,
    OAuth2Client: jest.fn(
      (opts: ConstructorParameters<typeof OAuth2Client>[0]) => {
        const real = new actual.OAuth2Client(opts);
        const fake: FakeClient = {
          generateAuthUrl: (o: object) =>
            real.generateAuthUrl(
              o as Parameters<typeof real.generateAuthUrl>[0],
            ),
          getToken: jest.fn(),
          verifyIdToken: jest.fn(),
        };
        return fake;
      },
    ),
  };
});

interface CtorMock {
  mock: {
    calls: [{ transporterOptions?: { timeout?: number } }][];
    results: { value: FakeClient }[];
  };
  mockClear: () => void;
}

const clientCtor = (): CtorMock => OAuth2Client as unknown as CtorMock;

/** The (mocked) client the service most recently built for itself. */
const clientOf = (): FakeClient => {
  const results = clientCtor().mock.results;
  return results[results.length - 1].value;
};

const ticketFor = (payload: unknown) => ({ getPayload: () => payload });

const SECRET = 'test-secret';

const configured: Record<string, string> = {
  'google.clientId': 'client-id.apps.googleusercontent.com',
  'google.clientSecret': 'client-secret',
  'jwt.secret': SECRET,
  publicApiUrl: 'https://api.mustard.watch',
  'cors.origin': 'https://mustard.watch,https://preview.vercel.app',
};

// ConfigService.get is typed by key; the test map is string-valued, so the
// one boolean lives beside it.
const withEnv = (values: Record<string, string>, isLocalEnv: boolean) =>
  new GoogleOAuthService({
    get: (key: string) => (key === 'isLocalEnv' ? isLocalEnv : values[key]),
  } as unknown as ConfigService);

/** Default: production-like, since that is the configuration that bites. */
const serviceWith = (values: Record<string, string>) => withEnv(values, false);

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

  it.each([
    ['missing entirely', ''],
    ['a lone comma', ','],
    ['only whitespace', '  '],
  ])('is disabled when the frontend origin is %s', (_name, origin) => {
    // credentials alone are not enough: with no canonical origin,
    // callbackRedirect builds a RELATIVE URL and the browser lands on a 404
    // at the API's own host, carrying a freshly minted token in the bar
    const service = serviceWith({ ...configured, 'cors.origin': origin });
    expect(service.enabled).toBe(false);
    expect(() => service.start(undefined)).toThrow(NotFoundException);
  });

  it.each([
    ['the localhost default', 'http://localhost:3001'],
    ['a loopback IP', 'http://127.0.0.1:3001'],
    ['IPv6 loopback', 'http://[::1]:3001'],
  ])(
    'refuses to offer the provider in production when the origin is %s',
    (_name, origin) => {
      // FRONTEND_URL is optional and falls back to localhost, so forgetting
      // it in production would show the button and then hand a real token
      // to whatever is listening on THAT PERSON's machine
      const service = withEnv({ ...configured, 'cors.origin': origin }, false);
      expect(service.enabled).toBe(false);
    },
  );

  it('still offers it on a laptop, where localhost is the point', () => {
    const service = withEnv(
      { ...configured, 'cors.origin': 'http://localhost:3001' },
      true,
    );
    expect(service.enabled).toBe(true);
  });

  it('offers it in production for a real origin', () => {
    expect(withEnv(configured, false).enabled).toBe(true);
  });

  it('bounds every call it makes to Google', () => {
    // gaxios has NO timeout by default, so a socket that opens and then goes
    // quiet would pin this request open for as long as the peer likes
    const service = serviceWith(configured);
    service.start(undefined);
    const calls = clientCtor().mock.calls;
    // the exact value, not merely positive: a 1ms timeout would satisfy
    // "greater than zero" and break every sign-in
    expect(calls[calls.length - 1][0].transporterOptions?.timeout).toBe(10_000);
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

describe('GoogleOAuthService.verifyCallback past the state check', () => {
  // These tests reach the calls that would leave the process, so each one
  // runs verifyCallback EXACTLY once - expectFailure above calls it twice,
  // which would double every mocked exchange and hide call-count bugs.
  let service: GoogleOAuthService;

  const openFlow = () => {
    const { authUrl, cookie } = service.start('/room/abc');
    return { state: new URL(authUrl).searchParams.get('state')!, cookie };
  };

  const failsWith = async (code: string) => {
    const { state, cookie } = openFlow();
    await expect(
      service.verifyCallback({ code: 'auth-code', state, cookie }),
    ).rejects.toMatchObject({ code });
  };

  beforeEach(() => {
    clientCtor().mockClear();
    service = serviceWith(configured);
    // force the client to exist so clientOf() can reach it
    service.start(undefined);
    clientOf().getToken.mockResolvedValue({
      tokens: { id_token: 'the-id-token' },
    });
    clientOf().verifyIdToken.mockResolvedValue(
      ticketFor({
        sub: 'google-sub-1',
        email: 'ada@example.com',
        email_verified: true,
        name: 'Ada Lovelace',
      }),
    );
  });

  it('returns the identity Google vouched for, and the way back', async () => {
    const { state, cookie } = openFlow();
    const result = await service.verifyCallback({
      code: 'auth-code',
      state,
      cookie,
    });

    expect(result.identity).toEqual({
      subject: 'google-sub-1',
      email: 'ada@example.com',
      emailVerified: true,
      name: 'Ada Lovelace',
    });
    expect(result.returnTo).toBe('/room/abc');
  });

  it('sends the PKCE verifier and our own redirect URI to the exchange', async () => {
    const { state, cookie } = openFlow();
    const verifier = openState(cookie, SECRET, Date.now())!.codeVerifier;

    await service.verifyCallback({ code: 'auth-code', state, cookie });

    expect(clientOf().getToken).toHaveBeenCalledTimes(1);
    expect(clientOf().getToken).toHaveBeenCalledWith({
      code: 'auth-code',
      codeVerifier: verifier,
      redirect_uri: service.redirectUri,
    });
  });

  it('verifies the ID token against our own client id', async () => {
    const { state, cookie } = openFlow();
    await service.verifyCallback({ code: 'auth-code', state, cookie });

    expect(clientOf().verifyIdToken).toHaveBeenCalledWith({
      idToken: 'the-id-token',
      audience: configured['google.clientId'],
    });
  });

  it('refuses an email Google will not vouch for', async () => {
    // this is the squatting defence, not a takeover one - we never link by
    // email - so it has to be a hard refusal, not a warning
    clientOf().verifyIdToken.mockResolvedValue(
      ticketFor({
        sub: 'google-sub-1',
        email: 'ada@example.com',
        email_verified: false,
      }),
    );
    await failsWith('unverified');
  });

  it.each([
    ['no subject', { email: 'ada@example.com', email_verified: true }],
    ['no email', { sub: 'google-sub-1', email_verified: true }],
    ['nothing at all', undefined],
  ])('refuses a payload with %s', async (_name, payload) => {
    clientOf().verifyIdToken.mockResolvedValue(ticketFor(payload));
    await failsWith('exchange');
  });

  it('reports a refused exchange without leaking why', async () => {
    clientOf().getToken.mockRejectedValue(new Error('invalid_grant'));
    await failsWith('exchange');
    expect(clientOf().verifyIdToken).not.toHaveBeenCalled();
  });

  it('reports a response carrying no ID token', async () => {
    clientOf().getToken.mockResolvedValue({ tokens: {} });
    await failsWith('exchange');
  });

  it('reports an ID token that fails verification', async () => {
    // a forged or expired token must not become an identity
    clientOf().verifyIdToken.mockRejectedValue(new Error('bad sig'));
    await failsWith('exchange');
  });
});

describe('isLoopback', () => {
  it.each([
    'http://localhost:3001',
    'https://localhost',
    'http://127.0.0.1:8080',
    'http://127.1.2.3',
    'http://[::1]:3001',
    'http://app.localhost',
  ])('%s only means something on one machine', (origin) => {
    expect(isLoopback(origin)).toBe(true);
  });

  it.each([
    'https://mustard.watch',
    'http://192.168.1.10',
    'https://a.example',
  ])('%s can be reached by someone else', (origin) => {
    expect(isLoopback(origin)).toBe(false);
  });

  it('treats an unparseable origin as unusable', () => {
    // not somewhere we can safely send a person holding a token
    expect(isLoopback('mustard.watch')).toBe(true);
    expect(isLoopback('')).toBe(true);
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
