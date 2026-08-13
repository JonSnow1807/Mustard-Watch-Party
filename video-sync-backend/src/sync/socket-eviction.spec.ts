import { Logger } from '@nestjs/common';
import type { Namespace, Socket } from 'socket.io';
import { evictRevoked, startExpirySweep } from './socket-eviction';
import type { AuthedSocketData } from './ws-auth';

const makeSocket = (data: Partial<AuthedSocketData>) => {
  const socket = {
    data: data as AuthedSocketData,
    emitted: [] as { event: string; body: unknown }[],
    disconnected: false,
    emit(event: string, body: unknown) {
      socket.emitted.push({ event, body });
      return true;
    },
    disconnect() {
      socket.disconnected = true;
      return socket as unknown as Socket;
    },
  };
  return socket;
};

/**
 * A NAMESPACE, whose sockets map is `sockets` directly.
 *
 * The first version of this double had `sockets: { sockets: Map }` - the
 * shape of `Server`, not of `Namespace`. Every test passed against it, and
 * the real thing threw on its first sweep and took the process down. A fake
 * that agrees with the wrong belief is worse than no test.
 */
const nsOf = (...sockets: ReturnType<typeof makeSocket>[]) =>
  ({
    sockets: new Map(sockets.map((s, i) => [String(i), s])),
  }) as unknown as Namespace;

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('closing connections a revocation should have closed', () => {
  // The gap this exists for: a socket is authenticated once, at connect, and
  // trusted while it stays open. Without eviction, signing out stops the REST
  // calls and leaves the person watching along on the live connection.

  it('closes the socket holding the revoked token, and no other', () => {
    const revoked = makeSocket({ userId: 'u1', jti: 'j1', tokenVersion: 0 });
    const other = makeSocket({ userId: 'u1', jti: 'j2', tokenVersion: 0 });

    const closed = evictRevoked([nsOf(revoked, other)], {
      kind: 'token',
      jti: 'j1',
    });

    expect(closed).toBe(1);
    jest.runAllTimers();
    expect(revoked.disconnected).toBe(true);
    expect(other.disconnected).toBe(false);
  });

  it('says why before it goes', () => {
    // A disconnect with no reason is indistinguishable from a network blip,
    // and the client will reconnect forever with the same dead token.
    const socket = makeSocket({ userId: 'u1', jti: 'j1', tokenVersion: 0 });
    evictRevoked([nsOf(socket)], { kind: 'token', jti: 'j1' });

    expect(socket.emitted).toEqual([
      { event: 'session-ended', body: { reason: 'session signed out' } },
    ]);
    // and the frame gets a tick to be written before the transport closes
    expect(socket.disconnected).toBe(false);
    jest.runAllTimers();
    expect(socket.disconnected).toBe(true);
  });

  it('closes every stale session of a user on sign-out-everywhere', () => {
    const phone = makeSocket({ userId: 'u1', jti: 'j1', tokenVersion: 0 });
    const laptop = makeSocket({ userId: 'u1', jti: 'j2', tokenVersion: 0 });
    const someoneElse = makeSocket({
      userId: 'u2',
      jti: 'j3',
      tokenVersion: 0,
    });

    const closed = evictRevoked([nsOf(phone, laptop, someoneElse)], {
      kind: 'user',
      userId: 'u1',
      version: 1,
    });

    expect(closed).toBe(2);
    jest.runAllTimers();
    expect(someoneElse.disconnected).toBe(false);
  });

  it('does not evict the session that did the signing out', () => {
    // Bumping the version issues a NEW token at the new version. Closing it
    // would sign you out of the device you just used to secure the account.
    const fresh = makeSocket({ userId: 'u1', jti: 'j9', tokenVersion: 1 });
    const closed = evictRevoked([nsOf(fresh)], {
      kind: 'user',
      userId: 'u1',
      version: 1,
    });
    expect(closed).toBe(0);
  });

  it('reaches the voice namespace too', () => {
    // /voice is a separate namespace with its own socket map, and its
    // connections carry the same token. Evicting only the default namespace
    // would leave voice up for someone who has just been signed out.
    const main = makeSocket({ userId: 'u1', jti: 'j1', tokenVersion: 0 });
    const voice = makeSocket({ userId: 'u1', jti: 'j1', tokenVersion: 0 });

    const closed = evictRevoked([nsOf(main), nsOf(voice)], {
      kind: 'token',
      jti: 'j1',
    });

    expect(closed).toBe(2);
  });
});

describe('closing connections whose token simply ran out', () => {
  it('closes an expired one and leaves a live one alone', () => {
    const now = 1_000_000;
    const dead = makeSocket({ userId: 'u1', expiresAt: now - 1 });
    const alive = makeSocket({ userId: 'u2', expiresAt: now + 60_000 });

    const stop = startExpirySweep(
      [nsOf(dead, alive)],
      new Logger('test'),
      () => now,
    );
    jest.advanceTimersByTime(30_000);
    jest.runOnlyPendingTimers();

    expect(dead.disconnected).toBe(true);
    expect(alive.disconnected).toBe(false);
    stop();
  });

  it('leaves a token with no expiry alone', () => {
    // Nothing issues these any more, but a token from before exp was
    // declared should not be closed on a guess.
    const socket = makeSocket({ userId: 'u1' });
    const stop = startExpirySweep([nsOf(socket)], new Logger('test'));
    jest.advanceTimersByTime(60_000);
    expect(socket.disconnected).toBe(false);
    stop();
  });

  it('stops sweeping when told to', () => {
    const now = 1_000_000;
    const dead = makeSocket({ userId: 'u1', expiresAt: now - 1 });
    const stop = startExpirySweep([nsOf(dead)], new Logger('test'), () => now);
    stop();
    jest.advanceTimersByTime(120_000);
    expect(dead.disconnected).toBe(false);
  });
});
