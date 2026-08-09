import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';
// One definition, shared with the REST guard (auth/jwt-auth.guard.ts) so the
// two planes cannot drift on what a token says.
import { subjectOf, type TokenPayload } from '../auth/token-payload';

/** Shape of socket.data after the middleware accepted the connection. */
export interface AuthedSocketData {
  userId: string;
  username: string;
  connectedAt: number;
}

/**
 * Socket.IO connection middleware: verify handshake.auth.token, derive
 * identity server-side into socket.data. Client-asserted userIds in event
 * payloads are dead from here on — handlers read socket.data.userId only.
 * Applied to both namespaces (/ and /voice).
 */
export function wsAuthMiddleware(jwt: JwtService) {
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
      const data = socket.data as AuthedSocketData;
      data.userId = sub;
      data.username = payload.name;
      data.connectedAt = Date.now();
      next();
    } catch {
      next(new Error('unauthorized: invalid token'));
    }
  };
}
