import { Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import type { AuthedSocketData } from './ws-auth';

/**
 * How often to look for connections whose token has died under them.
 *
 * A socket authenticates once, at connect. Everything after that is trusted
 * because the connection is open, which means an expired or revoked token
 * leaves the person watching along until they happen to disconnect - the
 * documented limitation that made revocation half a feature.
 */
const SWEEP_MS = 30_000;

const REASON = {
  expired: 'token expired',
  revoked: 'session signed out',
  allRevoked: 'signed out everywhere',
} as const;

type Reason = (typeof REASON)[keyof typeof REASON];

/**
 * Close a connection and tell it why before the socket goes away.
 *
 * The client needs the reason: a disconnect with no explanation is
 * indistinguishable from a network blip, and the reconnect logic will
 * cheerfully try again forever with the same dead token.
 */
const evict = (socket: Socket, reason: Reason): void => {
  socket.emit('session-ended', { reason });
  // A tick, so the frame is actually written. disconnect(true) closes the
  // underlying transport immediately, and an emit racing it is an emit the
  // client never sees.
  setTimeout(() => socket.disconnect(true), 50);
};

/**
 * Every connected socket across the namespaces we own.
 *
 * NAMESPACES, not Servers, and the difference cost a crash: `Server.sockets`
 * IS the default namespace, so `server.sockets.sockets` reads as a socket
 * map - but `server.of('/voice')` returns a Namespace, whose sockets live at
 * `namespace.sockets` directly. Casting one to the other type-checked, then
 * threw on the first sweep and took the process down with it. The unit test
 * did not catch it because the fake had the shape I believed in.
 */
const socketsOf = (namespaces: Namespace[]): Socket[] =>
  namespaces.flatMap((ns) => Array.from(ns.sockets.values()));

/**
 * Disconnect the live connections belonging to a revocation.
 *
 * Called the moment a token is revoked on this instance, and again when
 * another instance announces one - so signing out on your phone closes the
 * tab on your laptop in about as long as a round trip, not in twelve hours.
 */
export const evictRevoked = (
  namespaces: Namespace[],
  event: {
    kind: 'token' | 'user';
    jti?: string;
    userId?: string;
    version?: number;
  },
): number => {
  let closed = 0;
  for (const socket of socketsOf(namespaces)) {
    const data = socket.data as AuthedSocketData;
    if (event.kind === 'token' && event.jti && data.jti === event.jti) {
      evict(socket, REASON.revoked);
      closed++;
    } else if (
      event.kind === 'user' &&
      event.userId &&
      data.userId === event.userId &&
      (data.tokenVersion ?? 0) < (event.version ?? 0)
    ) {
      // Strictly less than: the version bump issues a NEW token, and the
      // session that did the signing-out must not evict itself.
      evict(socket, REASON.allRevoked);
      closed++;
    }
  }
  return closed;
};

/**
 * Start the periodic sweep for connections whose token has simply expired.
 *
 * Separate from eviction-on-revocation because it answers a different
 * question: not "was this taken away" but "did it run out". Both leave a
 * socket trusted that nothing would trust if it arrived now.
 */
export const startExpirySweep = (
  namespaces: Namespace[],
  logger: Logger,
  now: () => number = Date.now,
): (() => void) => {
  const timer = setInterval(() => {
    // A background sweep is not worth an unhandled rejection that ends the
    // process - which is exactly what the namespace mistake above did on its
    // first tick, in a timer where nothing was there to catch it.
    try {
      let closed = 0;
      for (const socket of socketsOf(namespaces)) {
        const data = socket.data as AuthedSocketData;
        if (typeof data.expiresAt === 'number' && data.expiresAt <= now()) {
          evict(socket, REASON.expired);
          closed++;
        }
      }
      if (closed > 0)
        logger.log(`closed ${closed} connection(s) on expired tokens`);
    } catch (err) {
      logger.warn(
        `expiry sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }, SWEEP_MS);

  // Node keeps the process alive for a pending timer; a sweep is not a
  // reason to refuse to shut down.
  timer.unref?.();
  return () => clearInterval(timer);
};

export const EVICTION_SWEEP_MS = SWEEP_MS;
export const EVICTION_REASONS = REASON;
