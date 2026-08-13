import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { subjectOf, type AuthedUser, TokenPayload } from './token-payload';
import { RevocationService } from './revocation.service';

/**
 * The request as this guard sees it: an Authorization header on the way in,
 * a server-derived identity on the way out. Declared structurally so the
 * guard, the @CurrentUser() decorator and the tests all agree on the one
 * property that matters without dragging in Express's Request surface.
 */
export interface AuthedRequest {
  headers?: { authorization?: string };
  user?: AuthedUser;
}

/**
 * REST counterpart to sync/ws-auth.ts: verify the bearer token, derive
 * identity server-side, attach it to the request. Same tokens, same secret
 * (JwtModule from AuthModule, keyed off config 'jwt.secret'), same claims
 * (TokenPayload) - the two planes cannot disagree about who a caller is.
 *
 * After this guard runs, a client-supplied userId in a body, query or path
 * is decoration. Handlers read @CurrentUser() and nothing else.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly revocations: RevocationService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const header = request.headers?.authorization;

    if (!header) {
      throw new UnauthorizedException(
        'Missing Authorization header (expected "Bearer <token>")',
      );
    }

    const parts = header.trim().split(/\s+/);
    const [scheme, token] = parts;
    if (parts.length !== 2 || scheme.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException(
        'Malformed Authorization header (expected "Bearer <token>")',
      );
    }

    let payload: TokenPayload;
    try {
      payload = this.jwt.verify<TokenPayload>(token);
    } catch (error) {
      // jsonwebtoken names the expiry case; everything else (bad signature,
      // wrong algorithm, garbage) is one indistinguishable "invalid" to the
      // caller on purpose - a probing client learns nothing about the key.
      const expired =
        (error as Error | undefined)?.name === 'TokenExpiredError';
      throw new UnauthorizedException(
        expired ? 'Token expired - sign in again' : 'Invalid token',
      );
    }

    // A signature proves the token is ours, not that it carries a subject.
    // Without one there is no identity to authorize against.
    // shared with the WS middleware so the two planes cannot drift
    if (subjectOf(payload) === null) {
      throw new UnauthorizedException('Token is missing a subject');
    }

    // A valid signature is not permission: the token may have been taken out
    // of circulation since it was signed. This reads an in-memory snapshot -
    // no database call, which is what lets this guard stay synchronous and
    // free of IO the way it was built to be.
    const revoked = this.revocations.isRevoked(payload);
    if (revoked !== null) {
      // The two are worth telling apart. "Signed out" is something the
      // person did; "signed out everywhere" may mean somebody else did it
      // because the account was compromised.
      throw new UnauthorizedException(
        revoked === 'token'
          ? 'This session was signed out - sign in again'
          : 'All sessions were signed out - sign in again',
      );
    }

    request.user = {
      userId: payload.sub,
      username: typeof payload.name === 'string' ? payload.name : '',
    };
    return true;
  }
}
