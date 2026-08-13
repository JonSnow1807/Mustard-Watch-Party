/**
 * The ONE JWT contract. Two planes verify these tokens - the WebSocket
 * handshake (sync/ws-auth.ts) and the REST guard (auth/jwt-auth.guard.ts) -
 * and both must read the same claims out of them, because they are the same
 * tokens: issued once by AuthService.issueToken, handed to the browser by
 * register/login, then sent on the socket handshake AND on every REST call.
 *
 * The shape lives here rather than beside either consumer so neither plane
 * can quietly grow a claim the other does not understand. If a claim is
 * added (roles, a session id), it is added here and both planes see it.
 */
export interface TokenPayload {
  /** User id. The subject - the only claim authorization ever keys off. */
  sub: string;
  /** Display name. Carried for convenience; never trusted for access. */
  name: string;
  /**
   * This token's own id, so ONE session can be revoked without touching the
   * others. Written on every token issued from now on.
   *
   * Optional in the type because tokens issued before revocation existed do
   * not carry one, and they stay valid until they expire. A token with no
   * jti simply cannot be individually revoked - `ver` still reaches it.
   */
  jti?: string;
  /**
   * The user's token version at the moment this was issued. If the user's
   * version has moved on, this token is stale and refused - the "sign out
   * everywhere" lever.
   *
   * Optional for the same reason as jti. A token with no ver is treated as
   * version 0, which is what every account starts at, so old tokens keep
   * working until someone actually revokes.
   */
  ver?: number;
  /**
   * Expiry, written by jsonwebtoken itself. Declared here because two things
   * now read it - the socket sweep that closes connections whose token has
   * died, and the revocation record that only needs keeping until then.
   *
   * SECONDS, not milliseconds. Everything else in this codebase is
   * milliseconds, so the conversion is the easiest mistake available here:
   * treating it as ms puts every token in January 1970 and expires the lot.
   */
  exp?: number;
}

/**
 * Identity as the rest of the app sees it, after a verified token has been
 * decoded. The WS plane stores this on socket.data; the REST plane attaches
 * it to the request, where @CurrentUser() reads it.
 *
 * A handler that has one of these has an identity the SERVER derived. Any
 * userId arriving in a body, query or path is a client assertion and is not
 * this.
 */
export interface AuthedUser {
  userId: string;
  username: string;
}

/**
 * A signature proves a token is ours; it does not prove the token carries a
 * subject. Both planes must reject a subject-less token, so the check lives
 * here rather than being written twice and drifting once.
 */
export function subjectOf(payload: TokenPayload): string | null {
  const sub = payload?.sub;
  return typeof sub === 'string' && sub.length > 0 ? sub : null;
}

/**
 * The version a token claims, for comparison against the user's current one.
 *
 * Absent means 0 - the version every account starts at - so tokens minted
 * before this claim existed keep working. A non-number is NOT treated as 0:
 * that would let a caller who could influence the payload downgrade
 * themselves past a revocation. There is no such caller today (we sign these
 * ourselves), and the check costs one comparison.
 */
export function versionOf(payload: TokenPayload): number | null {
  const ver = payload?.ver;
  if (ver === undefined || ver === null) return 0;
  return typeof ver === 'number' && Number.isInteger(ver) && ver >= 0
    ? ver
    : null;
}
