import { JwtService } from '@nestjs/jwt';
import { Socket } from 'socket.io';

interface TokenPayload {
  sub: string;
  name: string;
}

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
      const data = socket.data as AuthedSocketData;
      data.userId = payload.sub;
      data.username = payload.name;
      data.connectedAt = Date.now();
      next();
    } catch {
      next(new Error('unauthorized: invalid token'));
    }
  };
}
