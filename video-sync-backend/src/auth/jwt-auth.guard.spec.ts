import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtService, JwtSignOptions } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { AuthedRequest, JwtAuthGuard } from './jwt-auth.guard';
import type { RevocationService } from './revocation.service';
import { currentUser } from './current-user.decorator';
import type { TokenPayload } from './token-payload';
import { wsAuthMiddleware, AuthedSocketData } from '../sync/ws-auth';

/**
 * The REST plane had ZERO guards: every endpoint took the caller's word for
 * who they were (a userId in the body, or in the path). This guard is the
 * fix, and these tests pin the two things that make it a fix rather than a
 * formality:
 *
 *   1. every way of NOT presenting a valid token is a 401 - missing header,
 *      malformed header, foreign signature, expired token, subject-less
 *      payload. A guard that only rejects the empty case is a speed bump.
 *   2. the identity it attaches is the token's, and it is the SAME identity
 *      the WebSocket handshake derives from the same token (last test).
 */

const SECRET = 'test-secret-not-production';
const OTHER_SECRET = 'a-different-secret';

const jwt = new JwtService({ secret: SECRET });
/**
 * A revocation service that has revoked nothing.
 *
 * Named rather than inlined because "nothing is revoked" is the assumption
 * every test below already made implicitly, and it should be visible now
 * that it is a real dependency with its own answers.
 */
const nothingRevoked = {
  isRevoked: () => null,
} as unknown as RevocationService;

const guard = new JwtAuthGuard(jwt, nothingRevoked);

/** A guard whose snapshot refuses the token, for the two cases below. */
const guardRefusing = (why: 'token' | 'user') =>
  new JwtAuthGuard(jwt, {
    isRevoked: () => why,
  } as unknown as RevocationService);

/** A request carrying whatever Authorization header the test wants. */
function contextFor(
  authorization?: string,
  extra: Record<string, unknown> = {},
): { context: ExecutionContext; request: AuthedRequest } {
  const request: AuthedRequest = {
    headers: authorization === undefined ? {} : { authorization },
    ...extra,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

const sign = (payload: object, options?: JwtSignOptions) =>
  jwt.sign(payload, options);

describe('JwtAuthGuard', () => {
  it('rejects a request with no Authorization header', () => {
    const { context, request } = contextFor(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(context)).toThrow(/Missing Authorization/i);
    expect(request.user).toBeUndefined();
  });

  it('rejects a request whose headers object is absent entirely', () => {
    const context = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it.each([
    ['no scheme (bare token)', () => sign({ sub: 'u1', name: 'ana' })],
    ['wrong scheme', () => `Basic ${sign({ sub: 'u1', name: 'ana' })}`],
    ['scheme with no token', () => 'Bearer'],
    ['scheme with empty token', () => 'Bearer   '],
    [
      'extra junk after the token',
      () => `Bearer ${sign({ sub: 'u1', name: 'ana' })} extra`,
    ],
    ['empty header', () => ' '],
  ])('rejects a malformed Authorization header: %s', (_name, build) => {
    const { context, request } = contextFor(build());
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('rejects a token signed with a foreign secret', () => {
    // the forged-token case: well-formed, right claims, wrong key
    const forged = new JwtService({ secret: OTHER_SECRET }).sign({
      sub: 'victim',
      name: 'victim',
    });
    const { context, request } = contextFor(`Bearer ${forged}`);
    expect(() => guard.canActivate(context)).toThrow(/Invalid token/);
    expect(request.user).toBeUndefined();
  });

  it('rejects a tampered token (payload edited, signature stale)', () => {
    const token = sign({ sub: 'user-1', name: 'ana' });
    const [header, , signature] = token.split('.');
    const swapped = Buffer.from(
      JSON.stringify({ sub: 'someone-else', name: 'mallory' }),
    ).toString('base64url');
    const { context } = contextFor(`Bearer ${header}.${swapped}.${signature}`);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects an expired token, and says so', () => {
    // negative expiresIn (seconds): issued already stale
    const expired = sign({ sub: 'user-1', name: 'ana' }, { expiresIn: -10 });
    const { context, request } = contextFor(`Bearer ${expired}`);
    expect(() => guard.canActivate(context)).toThrow(/expired/i);
    expect(request.user).toBeUndefined();
  });

  it('rejects a validly signed token that carries no subject', () => {
    // a signature proves provenance, not that there is anyone to authorize
    const { context } = contextFor(`Bearer ${sign({ name: 'ana' })}`);
    expect(() => guard.canActivate(context)).toThrow(/subject/i);
  });

  it('accepts a valid token and attaches the identity from its claims', () => {
    const token = sign({ sub: 'user-1', name: 'ana' });
    const { context, request } = contextFor(`Bearer ${token}`);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual({ userId: 'user-1', username: 'ana' });
  });

  it('accepts a lower-case bearer scheme (RFC 7235 is case-insensitive)', () => {
    const { context, request } = contextFor(
      `bearer ${sign({ sub: 'user-1', name: 'ana' })}`,
    );
    expect(guard.canActivate(context)).toBe(true);
    expect(request.user?.userId).toBe('user-1');
  });

  it('takes identity from the token even when the request says otherwise', () => {
    // the whole point: the body/params are along for the ride now
    const token = sign({ sub: 'real-user', name: 'ana' });
    const { context, request } = contextFor(`Bearer ${token}`, {
      body: { userId: 'attacker' },
      params: { userId: 'attacker' },
    });

    guard.canActivate(context);
    expect(request.user?.userId).toBe('real-user');
  });

  describe('@CurrentUser() reads what the guard attached', () => {
    it('hands the handler the whole identity, or one field of it', () => {
      const { context } = contextFor(
        `Bearer ${sign({ sub: 'user-1', name: 'ana' })}`,
      );
      guard.canActivate(context);

      expect(currentUser(undefined, context)).toEqual({
        userId: 'user-1',
        username: 'ana',
      });
      expect(currentUser('userId', context)).toBe('user-1');
    });

    it('throws rather than yielding undefined on an unguarded route', () => {
      // if a route ever forgets @UseGuards, the failure must be loud - an
      // undefined userId written into creatorId is the silent version
      const { context } = contextFor('Bearer whatever');
      expect(() => currentUser('userId', context)).toThrow(
        UnauthorizedException,
      );
    });
  });

  it('derives the SAME identity as the WebSocket handshake, from one token', () => {
    // the anti-drift test. Both planes verify with this JwtService instance
    // and read TokenPayload; if either changes which claim is the user id,
    // this fails instead of the two planes silently disagreeing about who
    // is in the room.
    const payload: TokenPayload = { sub: 'user-1', name: 'ana' };
    const token = sign(payload);

    const { context, request } = contextFor(`Bearer ${token}`);
    guard.canActivate(context);

    const socket = { handshake: { auth: { token } }, data: {} };
    let wsError: Error | undefined;
    wsAuthMiddleware(jwt)(socket as unknown as Socket, (err) => {
      wsError = err;
    });
    const socketData = socket.data as AuthedSocketData;

    expect(wsError).toBeUndefined();
    expect({
      userId: socketData.userId,
      username: socketData.username,
    }).toEqual(request.user);
  });
});

describe('a token that is signed, unexpired, and no longer trusted', () => {
  // The gap this closes: signing out was a client-side event. The server
  // never heard, so any copy of the token kept working for the rest of its
  // life. A valid signature is not permission.
  const bearer = (token: string) =>
    ({ headers: { authorization: `Bearer ${token}` } }) as AuthedRequest;

  const ctx = (req: AuthedRequest) =>
    ({
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  it('refuses a token whose session was signed out', () => {
    const token = jwt.sign({ sub: 'u1', name: 'ada', jti: 'j1' });
    // The exact text, not /signed out/ - which also matches the account-wide
    // message, so a guard that reported "all sessions" for both reasons would
    // pass this and the test below. Telling them apart is the entire point of
    // returning a reason.
    expect(() =>
      guardRefusing('token').canActivate(ctx(bearer(token))),
    ).toThrow('This session was signed out - sign in again');
  });

  it('says something different when every session was signed out', () => {
    // Worth telling apart: one is something you did, the other may be
    // somebody else responding to a compromise.
    const token = jwt.sign({ sub: 'u1', name: 'ada', jti: 'j1' });
    expect(() => guardRefusing('user').canActivate(ctx(bearer(token)))).toThrow(
      'All sessions were signed out - sign in again',
    );
  });

  it('still lets an untouched token through', () => {
    const token = jwt.sign({ sub: 'u1', name: 'ada', jti: 'j1' });
    const req = bearer(token);
    expect(guard.canActivate(ctx(req))).toBe(true);
    expect(req.user).toEqual({ userId: 'u1', username: 'ada' });
  });
});
