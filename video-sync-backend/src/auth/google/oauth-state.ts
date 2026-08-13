import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/**
 * The short-lived secret that binds an OAuth round trip to one browser.
 *
 * `state` is the CSRF token echoed by the provider; `codeVerifier` is the
 * PKCE secret. Both live in an httpOnly cookie for the ~10 minutes between
 * the redirect out and the redirect back, and both are single-use.
 */
export interface OAuthStatePayload {
  /** the value handed to the provider as ?state= and echoed back */
  state: string;
  /** PKCE code_verifier; its S256 hash went to the provider */
  codeVerifier: string;
  /** where to send the browser once we are done (a path on our own origin) */
  returnTo?: string;
  /**
   * The guest this flow is attaching Google to, if it is a link rather than
   * a sign-in.
   *
   * It lives in the SEALED cookie rather than in the query string, and it is
   * the id the server verified from a bearer token at /link-start - not
   * anything the browser said about itself. A caller who could nominate the
   * account to attach a Google identity to would be able to attach theirs to
   * someone else's.
   */
  linkUserId?: string;
  /** absolute ms deadline - an abandoned flow must not stay resumable */
  expiresAt: number;
}

/**
 * Signed with a key DERIVED from the app secret rather than the app secret
 * itself. Same secret, different purpose: a sealed state and an access token
 * must never be interchangeable, and the cheapest way to guarantee that is
 * to make them verify under different keys. Domain separation costs one
 * HMAC and removes a whole class of confusion bug.
 */
const deriveKey = (secret: string): Buffer =>
  createHmac('sha256', secret).update('mustard:oauth-state:v1').digest();

const sign = (secret: string, body: string): string =>
  createHmac('sha256', deriveKey(secret)).update(body).digest('base64url');

/** Constant-time compare that tolerates length mismatch without throwing. */
export const safeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
};

export const sealState = (
  payload: OAuthStatePayload,
  secret: string,
): string => {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  );
  return `${body}.${sign(secret, body)}`;
};

/**
 * Returns null for anything that is not a live, intact seal - a tampered
 * body, a foreign signature, an expired flow, a cookie from a previous
 * deployment signed under an older secret. Every one of those means the
 * same thing to the caller (start over), so they get the same answer.
 */
export const openState = (
  sealed: string | undefined,
  secret: string,
  now: number,
): OAuthStatePayload | null => {
  if (!sealed) return null;
  const dot = sealed.indexOf('.');
  if (dot <= 0) return null;

  const body = sealed.slice(0, dot);
  const signature = sealed.slice(dot + 1);
  if (!safeEqual(signature, sign(secret, body))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const payload = parsed as Partial<OAuthStatePayload>;
  if (
    typeof payload?.state !== 'string' ||
    typeof payload?.codeVerifier !== 'string' ||
    typeof payload?.expiresAt !== 'number'
  ) {
    return null;
  }
  if (payload.expiresAt <= now) return null;

  return payload as OAuthStatePayload;
};

/** 32 bytes: the CSRF value and the PKCE verifier both want ≥256 bits. */
export const randomToken = (): string => randomBytes(32).toString('base64url');
