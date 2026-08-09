import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthedRequest } from './jwt-auth.guard';
import type { AuthedUser } from './token-payload';

/**
 * The verified caller, as derived by JwtAuthGuard.
 *
 *   @CurrentUser() user: AuthedUser      -> { userId, username }
 *   @CurrentUser('userId') id: string    -> just the id
 *
 * Throws if no identity is on the request, which can only mean the route
 * forgot @UseGuards(JwtAuthGuard). That is a wiring bug, and it fails loudly
 * here rather than handing a handler `undefined` to write into creatorId.
 */
export const CurrentUser = createParamDecorator(currentUser);

/**
 * The decorator's body, exported so it can be tested directly -
 * createParamDecorator hides the factory behind route metadata otherwise.
 */
export function currentUser(
  field: keyof AuthedUser | undefined,
  context: ExecutionContext,
): AuthedUser | string {
  const request = context.switchToHttp().getRequest<AuthedRequest>();
  const user = request.user;
  if (!user) {
    throw new UnauthorizedException(
      'No authenticated user on this request (route is missing JwtAuthGuard)',
    );
  }
  return field ? user[field] : user;
}
