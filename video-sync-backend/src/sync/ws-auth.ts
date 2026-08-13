import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
// One definition, shared with the REST guard (auth/jwt-auth.guard.ts) so the
// two planes cannot drift on what a token says.
import { subjectOf, type TokenPayload } from '../auth/token-payload';
import type { RevocationService } from '../auth/revocation.service';

/** Shape of socket.data after the middleware accepted the connection. */
export interface AuthedSocketData {
  userId: string;
  username: string;
  connectedAt: number;
  /**
   * The token this connection was accepted on, kept so the connection can
   * be closed when that token is revoked.
   *
   * A socket is authenticated once, at connect, and then trusted for as
   * long as it stays open - which is the gap that made revocation only half
   * a feature: signing out would stop the REST calls and leave the live
   * connection watching along. jti identifies the session, exp says when it
   * would have died on its own.
   */
  jti?: string;
  tokenVersion: number;
  expiresAt: number;
}

/**
 * Socket.IO connection middleware: verify handshake.auth.token, derive
 * identity server-side into socket.data. Client-asserted userIds in event
 * payloads are dead from here on — handlers read socket.data.userId only.
 * Applied to both namespaces (/ and /voice).
 */
export function wsAuthMiddleware(
  jwt: JwtService,
  revocations?: RevocationService,
) {
  return (socket: Socket, next: (err?: Error) => void): void => {
    const token = (socket.handshake.auth as { token?: string } | undefined)
      ?.token;
    if (!token) {
      next(new Error('unauthorized: missing token'));
      return;
    }
    try {
      const payload = jwt.verify<TokenPayload>(token);
      // shared with the REST guard: a valid signature is not a subject
      const sub = subjectOf(payload);
      if (sub === null) {
        next(new Error('unauthorized: token has no subject'));
        return;
      }
      // Same check as the REST guard, against the same in-memory snapshot:
      // a token revoked a moment ago must not be able to open a NEW
      // connection just because the signature is still good.
      if (revocations?.isRevoked(payload)) {
        next(new Error('unauthorized: token revoked'));
        return;
      }

      const data = socket.data as AuthedSocketData;
      data.userId = sub;
      data.username = payload.name;
      data.connectedAt = Date.now();
      data.jti = payload.jti;
      data.tokenVersion = payload.ver ?? 0;
      // jsonwebtoken puts exp in SECONDS; everything here is milliseconds,
      // and mixing the two would make every token look 1970-expired.
      // exp is in SECONDS (jsonwebtoken's doing); everything here is
      // milliseconds. A token with no exp never ages out on its own.
      data.expiresAt =
        typeof payload.exp === 'number'
          ? payload.exp * 1000
          : Number.POSITIVE_INFINITY;
      next();
    } catch {
      next(new Error('unauthorized: invalid token'));
    }
  };
}
