// src/auth/auth.service.ts
import {
  Injectable,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

@Injectable()
export class AuthService {
  constructor(
    private database: DatabaseService,
    private jwt: JwtService,
  ) {}

  private issueToken(user: { id: string; username: string }): string {
    return this.jwt.sign({ sub: user.id, name: user.username });
  }

  async register(username: string, email: string, password: string) {
    // Check if user exists
    const existingUser = await this.database.user.findFirst({
      where: {
        OR: [{ username }, { email }],
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
        username,
        email,
        password: hashedPassword,
      },
      select: {
        id: true,
        username: true,
        email: true,
        createdAt: true,
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

  /** The signed-in identity, for a client holding a token and nothing else. */
  async me(userId: string) {
    const user = await this.database.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true, email: true },
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
  async signInWithGoogle(identity: GoogleIdentity): Promise<SessionUser> {
    const email = identity.email.trim().toLowerCase();

    const linked = await this.database.oAuthAccount.findUnique({
      where: {
        provider_providerAccountId: {
          provider: GOOGLE,
          providerAccountId: identity.subject,
        },
      },
      select: { user: { select: { id: true, username: true, email: true } } },
    });

    if (linked) {
      return { ...linked.user, token: this.issueToken(linked.user) };
    }

    const emailOwner = await this.database.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true },
    });
    if (emailOwner) {
      throw new GoogleAuthError('email_taken');
    }

    return await this.createGoogleUser(identity, email);
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
          select: { id: true, username: true, email: true },
        });
        return { ...user, token: this.issueToken(user) };
      } catch (err) {
        // Two first-time sign-ins for the same Google account can race here.
        // The unique index is what actually decides; the loser re-reads the
        // winner's row instead of failing a sign-in that did succeed.
        if (isUniqueViolation(err, 'providerAccountId')) {
          return await this.signInWithGoogle(identity);
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
