import { api } from './api';
import type { InternalAxiosRequestConfig } from 'axios';

/**
 * Which requests carry the bearer token.
 *
 * This exists because the answer was wrong for three shipped features at
 * once. The rule was "never attach to /auth/*", written when every /auth
 * endpoint was unauthenticated. Then claim, google/link-start and logout
 * arrived - all guarded - and the rule silently stripped their credentials.
 * They 401'd, which is to say they did not work from a browser at all.
 *
 * Nothing caught it: every live check built its own headers and never went
 * through this file. So the check belongs here, at the layer that decides.
 */
const run = (url: string): InternalAxiosRequestConfig => {
  const handler = (
    api.interceptors.request as unknown as {
      handlers: {
        fulfilled: (c: InternalAxiosRequestConfig) => InternalAxiosRequestConfig;
      }[];
    }
  ).handlers[0].fulfilled;
  return handler({
    url,
    headers: {},
  } as unknown as InternalAxiosRequestConfig);
};

const authHeader = (url: string) =>
  (run(url).headers as Record<string, unknown>).Authorization;

beforeEach(() => {
  localStorage.setItem('user', JSON.stringify({ id: 'u1', token: 'tok-123' }));
});

afterEach(() => localStorage.clear());

describe('endpoints that need the token', () => {
  // Every one of these is behind JwtAuthGuard. Without the header they 401.
  it.each([
    ['/auth/logout'],
    ['/auth/logout-all'],
    ['/auth/claim'],
    ['/auth/google/link-start'],
    ['/rooms'],
    ['/rooms/abc'],
  ])('%s carries it', (url) => {
    expect(authHeader(url)).toBe('Bearer tok-123');
  });
});

describe('endpoints where a token is meaningless', () => {
  // The original reasoning, still right: sending a token to login makes a
  // bad-password 401 indistinguishable from an expired-session 401 in the
  // response interceptor, which would wipe a good session over a typo.
  it.each([
    ['/auth/login'],
    ['/auth/register'],
    ['/auth/guest'],
    ['/auth/providers'],
    ['/auth/google/start'],
  ])('%s does not', (url) => {
    expect(authHeader(url)).toBeUndefined();
  });
});

describe('with no stored session', () => {
  it('sends nothing rather than the word undefined', () => {
    localStorage.clear();
    expect(authHeader('/auth/logout')).toBeUndefined();
    expect(authHeader('/rooms')).toBeUndefined();
  });
});

describe('an explicitly-set Authorization header', () => {
  it('is never overwritten by the stored session', () => {
    // setPasswordElevated carries the five-minute elevated token; the
    // interceptor replacing it with the stored session would silently
    // un-elevate the one call that needs elevation
    const cfg = run('/auth/set-password');
    expect(cfg.headers.Authorization).toBe('Bearer tok-123'); // default path
    const handler = (
      api.interceptors.request as unknown as {
        handlers: {
          fulfilled: (
            c: import('axios').InternalAxiosRequestConfig,
          ) => import('axios').InternalAxiosRequestConfig;
        }[];
      }
    ).handlers[0].fulfilled;
    const explicit = handler({
      url: '/auth/set-password',
      headers: { Authorization: 'Bearer elevated-token' },
    } as unknown as import('axios').InternalAxiosRequestConfig);
    expect((explicit.headers as Record<string, unknown>).Authorization).toBe(
      'Bearer elevated-token',
    );
  });
});


describe('the response interceptor clears the session narrowly', () => {
  const reject = (status: number, authHeader?: string) => {
    const handler = (
      api.interceptors.response as unknown as {
        handlers: { rejected: (e: unknown) => Promise<never> }[];
      }
    ).handlers[0].rejected;
    return handler({
      response: { status },
      config: { headers: authHeader ? { Authorization: authHeader } : {} },
    }).catch(() => undefined);
  };

  beforeEach(() =>
    localStorage.setItem('user', JSON.stringify({ id: 'u1', token: 'stored-tok' })),
  );
  afterEach(() => localStorage.clear());

  it('clears when the STORED token is the one rejected', async () => {
    await reject(401, 'Bearer stored-tok');
    expect(localStorage.getItem('user')).toBeNull();
  });

  it('does NOT clear when a DIFFERENT token is rejected', async () => {
    // the elevated set-password token failing, or a wrong-password re-auth
    // behind a good session: the stored session must survive
    await reject(401, 'Bearer elevated-tok');
    expect(localStorage.getItem('user')).not.toBeNull();
  });

  it('does NOT clear on a 401 that carried no token at all', async () => {
    // a bad login: clearing would wipe a good session over a typo
    await reject(401, undefined);
    expect(localStorage.getItem('user')).not.toBeNull();
  });
});
