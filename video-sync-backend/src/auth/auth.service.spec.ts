import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { AuthService } from './auth.service';
import { DatabaseService } from '../database/database.service';
import { GoogleAuthError, GoogleIdentity } from './google/google-oauth.service';

const jwtService = new JwtService({ secret: 'test-secret' });

const identity: GoogleIdentity = {
  subject: 'google-sub-123',
  email: 'Ada@Example.com',
  emailVerified: true,
  name: 'Ada Lovelace',
};

const uniqueViolation = (target: string) =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });

/** Just the calls AuthService makes, so a shape change fails loudly here. */
const makeDb = () => ({
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
  },
  oAuthAccount: {
    findUnique: jest.fn().mockResolvedValue(null),
  },
});

/** The shape AuthService writes, so the assertions below are type-checked. */
interface CreateUserArgs {
  data: {
    username: string;
    email: string;
    password: string | null;
    oauthAccounts: { create: { provider: string; providerAccountId: string } };
  };
}

const createCalls = (db: ReturnType<typeof makeDb>): CreateUserArgs[] =>
  (db.user.create.mock.calls as CreateUserArgs[][]).map((call) => call[0]);

const serviceWith = (db: ReturnType<typeof makeDb>) =>
  new AuthService(db as unknown as DatabaseService, jwtService);

describe('login with provider-only accounts in the table', () => {
  it('answers a passwordless account with the same 401 as a wrong password', async () => {
    // bcrypt.compare(password, null) THROWS. Without the null check that is
    // a 500, and a 500-vs-401 split tells an enumerator exactly which
    // accounts signed up with Google.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      email: 'ada@example.com',
      password: null,
    });

    await expect(serviceWith(db).login('ada', 'guess')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('still signs in a password account', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      email: 'ada@example.com',
      password: await bcrypt.hash('correct-horse', 10),
    });

    const result = await serviceWith(db).login('ada', 'correct-horse');
    expect(result).toMatchObject({ id: 'u1', username: 'ada' });
    expect(jwtService.verify(result.token)).toMatchObject({
      sub: 'u1',
      name: 'ada',
    });
  });
});

describe('signInWithGoogle', () => {
  it('finds the user by (provider, subject) - never by email', async () => {
    const db = makeDb();
    db.oAuthAccount.findUnique.mockResolvedValue({
      user: { id: 'u9', username: 'ada', email: 'ada@example.com' },
    });

    const result = await serviceWith(db).signInWithGoogle(identity);

    expect(result).toMatchObject({ id: 'u9', username: 'ada' });
    expect(db.oAuthAccount.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider_providerAccountId: {
            provider: 'google',
            providerAccountId: 'google-sub-123',
          },
        },
      }),
    );
    // a returning user is a lookup, not a write
    expect(db.user.create).not.toHaveBeenCalled();
  });

  // THE takeover case. Local emails have never been verified by us, so
  // anyone could have registered a password account under someone else's
  // address. Auto-linking would hand whoever did that a permanent password
  // into the real owner's account. We refuse and say why instead.
  it('refuses to link onto an existing local account with that email', async () => {
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ id: 'squatter' });

    await expect(
      serviceWith(db).signInWithGoogle(identity),
    ).rejects.toMatchObject({ code: 'email_taken' });
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it('matches that existing account case-insensitively', async () => {
    // the column's uniqueness is case-SENSITIVE, so a case-sensitive lookup
    // would sail past 'ada@example.com' and then hit a raw P2002 on insert
    const db = makeDb();
    db.user.findFirst.mockResolvedValue({ id: 'squatter' });

    await expect(serviceWith(db).signInWithGoogle(identity)).rejects.toThrow(
      GoogleAuthError,
    );
    expect(db.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'ada@example.com', mode: 'insensitive' } },
      }),
    );
  });

  it('creates a passwordless user with the identity attached', async () => {
    const db = makeDb();
    db.user.create.mockResolvedValue({
      id: 'u-new',
      username: 'ada_lovelace',
      email: 'ada@example.com',
    });

    const result = await serviceWith(db).signInWithGoogle(identity);

    expect(result).toMatchObject({ id: 'u-new', username: 'ada_lovelace' });
    const args = createCalls(db)[0];
    expect(args.data.username).toBe('ada_lovelace');
    // normalised on the way in, so the next sign-in's lookup agrees
    expect(args.data.email).toBe('ada@example.com');
    // null, not a random unusable hash - an unusable hash is still a hash
    expect(args.data.password).toBeNull();
    expect(args.data.oauthAccounts.create).toMatchObject({
      provider: 'google',
      providerAccountId: 'google-sub-123',
    });
    // the token is the same contract the socket plane verifies
    expect(jwtService.verify(result.token)).toMatchObject({
      sub: 'u-new',
      name: 'ada_lovelace',
    });
  });

  it('draws another username when the first is taken', async () => {
    const db = makeDb();
    db.user.create
      .mockRejectedValueOnce(uniqueViolation('username'))
      .mockResolvedValue({
        id: 'u-new',
        username: 'ada_lovelace_4242',
        email: 'ada@example.com',
      });

    const result = await serviceWith(db).signInWithGoogle(identity);

    expect(result.username).toBe('ada_lovelace_4242');
    expect(db.user.create).toHaveBeenCalledTimes(2);
    const [first, second] = createCalls(db).map((c) => c.data.username);
    expect(second).not.toBe(first);
    expect(second.startsWith('ada_lovelace')).toBe(true);
  });

  it('gives up rather than looping forever on a username it can never get', async () => {
    const db = makeDb();
    db.user.create.mockRejectedValue(uniqueViolation('username'));

    await expect(serviceWith(db).signInWithGoogle(identity)).rejects.toThrow(
      /username/i,
    );
    expect(createCalls(db).length).toBeLessThanOrEqual(8);
  });

  it('lets the winner of a first-sign-in race decide, and returns its user', async () => {
    // two tabs, one Google account, no prior link: both read "not linked",
    // both insert, the unique index picks one. The loser must return the
    // winner's user rather than fail a sign-in that actually succeeded.
    const db = makeDb();
    db.user.create.mockRejectedValueOnce(uniqueViolation('providerAccountId'));
    db.oAuthAccount.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        user: { id: 'u-winner', username: 'ada_lovelace', email: 'a@b.c' },
      });

    const result = await serviceWith(db).signInWithGoogle(identity);

    expect(result.id).toBe('u-winner');
    expect(db.user.create).toHaveBeenCalledTimes(1);
  });

  it('reports a racing email insert as email_taken, not a 500', async () => {
    const db = makeDb();
    db.user.create.mockRejectedValue(uniqueViolation('email'));

    await expect(
      serviceWith(db).signInWithGoogle(identity),
    ).rejects.toMatchObject({ code: 'email_taken' });
  });

  it('lets an unexpected database error surface unchanged', async () => {
    // swallowing this as a sign-in failure would hide an outage behind a
    // message telling people to try another account
    const db = makeDb();
    db.user.create.mockRejectedValue(new Error('connection reset'));

    await expect(serviceWith(db).signInWithGoogle(identity)).rejects.toThrow(
      'connection reset',
    );
  });
});
