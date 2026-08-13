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
