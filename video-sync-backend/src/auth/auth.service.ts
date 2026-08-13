// src/auth/auth.service.ts
import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { DatabaseService } from '../database/database.service';
import * as bcrypt from 'bcrypt';
import { GoogleAuthError, GoogleIdentity } from './google/google-oauth.service';
import { usernameBase, usernameCandidates } from './google/username';

const GOOGLE = 'google';

/** What every sign-in path returns: an identity plus the token for it. */
export interface SessionUser {
  id: string;
  username: string;
  email: string;
  token: string;
}

/** Enough draws from 10^4 that exhausting them means something else is wrong. */
const USERNAME_ATTEMPTS = 8;

const isUniqueViolation = (err: unknown, field: string): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === 'P2002' &&
  ((err.meta?.target as string[] | undefined) ?? []).some((t) =>
    t.includes(field),
  );

/**
 * What a name, an address and a password have to be to open an account.
 *
 * One function, because there are two doors into the same table - register
 * and claimGuestAccount - and for a while only the newer one checked
 * anything. Validating the door you happen to be building reads as though
 * the other was considered and passed. It had not been.
 *
 * Returns the cleaned values so callers cannot validate one string and then
 * store a different one.
 */
export const credentialsOrThrow = (
  username: string,
  email: string,
  password: string,
): { username: string; email: string } => {
  const cleanUsername = (username ?? '').trim();
  const cleanEmail = (email ?? '').trim().toLowerCase();

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanUsername)) {
    throw new BadRequestException(
      'Names are 3-32 characters: letters, numbers, dot, dash, underscore',
    );
  }
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(cleanEmail)) {
    throw new BadRequestException('That email address does not look right');
  }
  if (cleanEmail.endsWith('@guest.invalid')) {
    // The address a guest row is born with. An account that keeps it can
    // never receive a password reset.
    throw new BadRequestException('Use an address you can actually receive');
  }
  if ((password ?? '').length < 8) {
    throw new BadRequestException('Passwords are at least 8 characters');
  }

  return { username: cleanUsername, email: cleanEmail };
};

@Injectable()
export class AuthService {
  constructor(
    private database: DatabaseService,
    private jwt: JwtService,
  ) {}

  /**
   * Mint a session token.
   *
   * `tokenVersion` is REQUIRED rather than optional, and that is the whole
   * defence against the worst bug this feature can have: a token issued
   * carrying version 0 for a user whose version has moved on is refused the
   * instant it is used. Someone signs in, gets a token, and is immediately
   * signed out again, with the logs saying only "revoked". Making the type
   * demand it means the compiler finds every issuance site instead of me.
   *
   * The jti is what lets ONE session be revoked later; without it the only
   * lever is the version, which takes out every session the user has.
   */
  private issueToken(user: {
    id: string;
    username: string;
    tokenVersion: number;
  }): string {
    return this.jwt.sign({
      sub: user.id,
      name: user.username,
      jti: randomUUID(),
      ver: user.tokenVersion,
    });
  }

  async register(username: string, email: string, password: string) {
    const { username: cleanUsername, email: cleanEmail } = credentialsOrThrow(
      username,
      email,
      password,
    );

    // Check if user exists
    const existingUser = await this.database.user.findFirst({
      where: {
        OR: [{ username: cleanUsername }, { email: cleanEmail }],
      },
    });

    if (existingUser) {
      throw new ConflictException('User already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const user = await this.database.user.create({
      data: {
        username: cleanUsername,
        email: cleanEmail,
        password: hashedPassword,
      },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
        tokenVersion: true,
      },
    });

    return { ...user, token: this.issueToken(user) };
  }

  async login(username: string, password: string) {
    // Find user
    const user = await this.database.user.findUnique({
      where: { username },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // An account that only ever arrived through Google has no password to
    // compare. This check has to come BEFORE bcrypt: passing null to
    // bcrypt.compare throws, which would turn "wrong door" into a 500 and
    // hand an enumerator a way to tell provider-only accounts apart from
    // password ones. Same 401 either way.
    if (!user.password) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // Check password
    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      token: this.issueToken(user),
    };
  }

  /**
   * A way in for someone who followed an invite link and does not want an
   * account.
   *
   * The row is real (docs/GUEST_ACCESS.md): the socket handshake refuses a
   * token with no subject, and Participant.userId and ChatMessage.userId are
   * both foreign keys, so a rowless guest would need a nullable FK and a
   * branch at every read. A User with no password satisfies all three and
   * costs one boolean.
   *
   * This grants nothing registration does not already grant - anyone can
   * register with an address they do not own - so it is not a new surface,
   * it is the same one without the form.
   */
  async createGuest(): Promise<SessionUser> {
    const candidates = usernameCandidates('guest');

    for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
      const username = candidates.next().value as string;
      try {
        const user = await this.database.user.create({
          data: {
            username,
            // email is @unique NOT NULL, so a guest needs one that can never
            // collide with a real person's. .invalid is reserved by RFC 2606
            // and can never be registered, so this address is unroutable by
            // construction rather than by convention.
            email: `${randomUUID()}@guest.invalid`,
            password: null,
            isGuest: true,
          },
          select: { id: true, username: true, email: true, tokenVersion: true },
        });
        return { ...user, token: this.issueToken(user) };
      } catch (err) {
        // 'guest' is a popular name by design - collisions are expected and
        // the generator's job, not an error
        if (isUniqueViolation(err, 'username')) continue;
        throw err;
      }
    }

    throw new ConflictException('Could not allocate a guest name');
  }

  /** The signed-in identity, for a client holding a token and nothing else. */
  async me(userId: string) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true, tokenVersion: true },
    });
    if (!user) {
      // A valid signature over a user that no longer exists - a deleted
      // account holding a token that has not expired yet.
      throw new NotFoundException('User not found');
    }
    return user;
  }

  /**
   * Turn a Google identity into a local session.
   *
   * The lookup key is (provider, subject) and nothing else. Notably NOT
   * email: local emails have never been verified by us, so anyone could
   * have registered a password account under someone else's address, and
   * matching on it would hand them that person's Google sign-in - or hand
   * the victim an account the attacker still has the password to. So when
   * the address is already spoken for locally we stop and say so, rather
   * than guessing which of the two humans is in front of us.
   */
  /**
   * Turn a guest into a real account IN PLACE.
   *
   * The row keeps its id, which is the whole point. A guest who spent an
   * evening in a room is the author of its chat messages and a member of its
   * participant list, both by foreign key; creating a fresh account and
   * copying nothing would leave those rows pointing at a name that is about
   * to be swept, and the conversation people are still reading would go
   * blank. So this is an UPDATE, not an insert.
   *
   * Only a guest can do this. An account with a password reaching here would
   * mean a stolen token could overwrite someone's credentials, so the guard
   * is on the row rather than on the caller's word about themselves.
   */
  async claimGuestAccount(
    userId: string,
    username: string,
    email: string,
    password: string,
  ): Promise<SessionUser> {
    const { username: cleanUsername, email: cleanEmail } = credentialsOrThrow(
      username,
      email,
      password,
    );

    const current = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, isGuest: true },
    });

    if (!current) throw new UnauthorizedException('No such session');
    if (!current.isGuest) {
      // Not a 409: telling an attacker holding a stolen token which accounts
      // are claimable is a free enumeration oracle.
      throw new ForbiddenException('This session is already a full account');
    }

    // Checked before the write for a clear error, and caught after it too -
    // between these two statements someone else can take the same name, and
    // the database is the only thing that can actually arbitrate.
    const taken = await this.database.user.findFirst({
      where: {
        OR: [{ username: cleanUsername }, { email: cleanEmail }],
        NOT: { id: userId },
      },
      select: { id: true },
    });
    if (taken) throw new ConflictException('That name or email is taken');

    const hashedPassword = await bcrypt.hash(password, 10);

    try {
      const user = await this.database.user.update({
        where: { id: userId, isGuest: true },
        data: {
          username: cleanUsername,
          email: cleanEmail,
          password: hashedPassword,
          isGuest: false,
        },
        select: { id: true, username: true, email: true, tokenVersion: true },
      });
      // A fresh token: the old one carries the guest name, which is about to
      // be wrong everywhere it is displayed.
      return { ...user, token: this.issueToken(user) };
    } catch (err) {
      if (
        isUniqueViolation(err, 'username') ||
        isUniqueViolation(err, 'email')
      ) {
        throw new ConflictException('That name or email is taken');
      }
      throw err;
    }
  }

  /**
   * Attach a Google identity to the guest row already in use.
   *
   * The password path for this is claimGuestAccount; this is the same
   * promise for someone who would rather not invent another password. Same
   * rule, and the same reason: the row keeps its id, so the chat messages
   * and participant rows pointing at it stay pointing at a live account.
   *
   * Order matters here. The provider link is checked BEFORE anything is
   * written, because a Google account already attached to a real account
   * must not be quietly moved onto a guest row - that would be an account
   * takeover with the victim's own credentials.
   */
  async linkGoogleToGuest(
    userId: string,
    identity: GoogleIdentity,
  ): Promise<SessionUser> {
    const current = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, isGuest: true },
    });
    if (!current) throw new UnauthorizedException('No such session');
    if (!current.isGuest) {
      throw new ForbiddenException({
        code: 'link_not_guest',
        message: 'This session is already a full account',
      });
    }

    const email = identity.email.trim().toLowerCase();

    // Already linked somewhere? Then this Google account belongs to that
    // user, and the answer is to sign in as them - not to graft it onto a
    // guest.
    const existingLink = await this.database.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: 'google',
          providerAccountId: identity.subject,
        },
      },
      select: { userId: true },
    });
    if (existingLink && existingLink.userId !== userId) {
      throw new ConflictException({
        // A CODE alongside the message, because the OAuth callback answers in
        // a redirect fragment and that channel carries codes by design - the
        // API does not know how the frontend words things, and a code cannot
        // leak anything about the account it refused.
        code: 'link_provider_taken',
        message:
          'That Google account is already signed in here - sign in with it instead',
      });
    }

    // The address is unique on User, and we are about to take it.
    const addressTaken = await this.database.user.findFirst({
      where: { email, NOT: { id: userId } },
      select: { id: true },
    });
    if (addressTaken) {
      throw new ConflictException({
        code: 'link_email_taken',
        message:
          'An account with that email already exists - sign in with it instead',
      });
    }

    // A guest is called guest_1234, which is nobody's name. Take one from
    // the Google profile, with the same collision walk registration uses.
    const candidates = usernameCandidates(usernameBase(identity.name, email));

    for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
      const username = candidates.next().value as string;
      try {
        const user = await this.database.user.update({
          where: { id: userId, isGuest: true },
          data: {
            username,
            email,
            isGuest: false,
            // password stays null: this account signs in with Google, and
            // login() already refuses a null password rather than passing it
            // to bcrypt
            oauthAccounts: {
              create: {
                provider: 'google',
                providerAccountId: identity.subject,
              },
            },
          },
          select: { id: true, username: true, email: true, tokenVersion: true },
        });
        return { ...user, token: this.issueToken(user) };
      } catch (err) {
        if (isUniqueViolation(err, 'username')) continue;
        if (isUniqueViolation(err, 'providerAccountId')) {
          // lost a race with another flow linking the same Google account
          throw new ConflictException({
            code: 'link_provider_taken',
            message:
              'That Google account is already signed in here - sign in with it instead',
          });
        }
        if (isUniqueViolation(err, 'email')) {
          throw new ConflictException({
            code: 'link_email_taken',
            message:
              'An account with that email already exists - sign in with it instead',
          });
        }
        throw err;
      }
    }

    throw new ConflictException('Could not allocate a name');
  }

  async signInWithGoogle(identity: GoogleIdentity): Promise<SessionUser> {
    const email = identity.email.trim().toLowerCase();

    const linked = await this.findLinkedUser(identity.subject);
    if (linked) return linked;

    const emailOwner = await this.database.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (emailOwner) {
      throw new GoogleAuthError('email_taken');
    }

    return await this.createGoogleUser(identity, email);
  }

  /** The local user behind a provider subject, or null if not linked yet. */
  private async findLinkedUser(subject: string): Promise<SessionUser | null> {
    const linked = await this.database.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: GOOGLE,
          providerAccountId: subject,
        },
      },
      select: {
        user: {
          select: {
            id: true,
            username: true,
            email: true,
            tokenVersion: true,
          },
        },
      },
    });
    return linked
      ? { ...linked.user, token: this.issueToken(linked.user) }
      : null;
  }

  private async createGoogleUser(
    identity: GoogleIdentity,
    email: string,
  ): Promise<SessionUser> {
    const candidates = usernameCandidates(usernameBase(identity.name, email));

    for (let attempt = 0; attempt < USERNAME_ATTEMPTS; attempt++) {
      const username = candidates.next().value as string;
      try {
        const user = await this.database.user.create({
          data: {
            username,
            email,
            // No password: see the schema note. There is deliberately no
            // random filler here - an unusable hash is still a hash, and
            // null is the honest statement that this account has no
            // password login.
            password: null,
            oauthAccounts: {
              create: {
                provider: GOOGLE,
                providerAccountId: identity.subject,
                email,
              },
            },
          },
          select: { id: true, username: true, email: true, tokenVersion: true },
        });
        return { ...user, token: this.issueToken(user) };
      } catch (err) {
        // Two first-time sign-ins for the same Google account can race here.
        // The unique index is what actually decides; the loser re-reads the
        // winner's row instead of failing a sign-in that did succeed.
        //
        // Re-read directly rather than restarting signInWithGoogle: that
        // would recurse, and if the row somehow still did not read back
        // (a lagging replica, say) it would recurse again, and again. A
        // constraint that fires with nothing behind it is a real anomaly,
        // so it gets raised rather than retried forever.
        if (isUniqueViolation(err, 'providerAccountId')) {
          const winner = await this.findLinkedUser(identity.subject);
          if (winner) return winner;
          throw err;
        }
        // Lost the name to someone else between generating and inserting:
        // draw again.
        if (isUniqueViolation(err, 'username')) continue;
        // Someone registered that address in the last few milliseconds, or
        // it differs only by case from an existing one (our lookup above is
        // case-insensitive, the column's uniqueness is not).
        if (isUniqueViolation(err, 'email')) {
          throw new GoogleAuthError('email_taken');
        }
        throw err;
      }
    }

    throw new ConflictException('Could not allocate a username');
  }
}
