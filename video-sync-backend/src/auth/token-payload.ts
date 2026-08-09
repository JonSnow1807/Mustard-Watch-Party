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
