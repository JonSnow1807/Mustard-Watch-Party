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
    update: jest.fn(),
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

  it('raises rather than spinning when the constraint fires with nothing behind it', async () => {
    // P2002 on the provider identity but no row reads back - a lagging
    // replica, or something genuinely wrong. Re-entering the sign-in here
    // would recurse forever on a condition that is not going to change.
    const db = makeDb();
    db.user.create.mockRejectedValue(uniqueViolation('providerAccountId'));
    db.oAuthAccount.findUnique.mockResolvedValue(null);

    await expect(serviceWith(db).signInWithGoogle(identity)).rejects.toThrow(
      /unique constraint/i,
    );
    expect(createCalls(db).length).toBe(1);
  });

  it('reports a racing email insert as email_taken, not a 500', async () => {
    const db = makeDb();
    db.user.create.mockRejectedValue(uniqueViolation('email'));

    await expect(
      serviceWith(db).signInWithGoogle(identity),
    ).rejects.toMatchObject({ code: 'email_taken' });
    // terminal, not retried: only a username collision earns another draw,
    // and widening the retry would mean hammering a constraint that can
    // never be satisfied
    expect(createCalls(db).length).toBe(1);
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

describe('createGuest', () => {
  const guestArgs = (db: ReturnType<typeof makeDb>) =>
    (db.user.create.mock.calls as { data: Record<string, unknown> }[][]).map(
      (c) => c[0].data,
    );

  it('creates a passwordless, flagged account with an unroutable address', async () => {
    const db = makeDb();
    db.user.create.mockResolvedValue({
      id: 'g1',
      username: 'guest',
      email: 'x@guest.invalid',
    });

    const result = await serviceWith(db).createGuest();

    const data = guestArgs(db)[0];
    expect(data.isGuest).toBe(true);
    // null, not an unusable hash - there is no password login for a guest
    expect(data.password).toBeNull();
    // .invalid is reserved by RFC 2606, so this can never collide with a
    // real person's address or be delivered to
    expect(String(data.email)).toMatch(/@guest\.invalid$/);
    // and the token is the same contract both planes verify
    expect(jwtService.verify(result.token)).toMatchObject({ sub: 'g1' });
  });

  it('gives every guest a different address', async () => {
    const db = makeDb();
    db.user.create.mockResolvedValue({ id: 'g', username: 'g', email: 'e' });
    const service = serviceWith(db);
    await service.createGuest();
    await service.createGuest();

    const [first, second] = guestArgs(db).map((d) => d.email);
    expect(first).not.toBe(second);
  });

  it('draws another name when the first is taken', async () => {
    // 'guest' is a popular name by design; a collision is the generator's
    // job, not an error
    const db = makeDb();
    db.user.create
      .mockRejectedValueOnce(uniqueViolation('username'))
      .mockResolvedValue({ id: 'g2', username: 'guest_0042', email: 'e' });

    const result = await serviceWith(db).createGuest();

    expect(result.username).toBe('guest_0042');
    const names = guestArgs(db).map((d) => d.username);
    expect(names[1]).not.toBe(names[0]);
  });

  it('gives up rather than looping forever', async () => {
    const db = makeDb();
    db.user.create.mockRejectedValue(uniqueViolation('username'));
    await expect(serviceWith(db).createGuest()).rejects.toThrow(/guest name/i);
    expect(guestArgs(db).length).toBeLessThanOrEqual(8);
  });

  it('lets an unexpected database error surface', async () => {
    const db = makeDb();
    db.user.create.mockRejectedValue(new Error('connection reset'));
    await expect(serviceWith(db).createGuest()).rejects.toThrow(
      'connection reset',
    );
  });
});

describe('claiming a guest account', () => {
  const guestRow = { id: 'g1', isGuest: true };

  const claiming = () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(guestRow);
    db.user.update.mockResolvedValue({
      id: 'g1',
      username: 'ada',
      email: 'ada@example.com',
    });
    return { db, service: serviceWith(db) };
  };

  it('updates the guest row in place, keeping its id', async () => {
    // The whole point. Chat messages and participant rows point at this id
    // by foreign key - a new account would leave last night's conversation
    // attributed to a name about to be swept.
    const { db, service } = claiming();
    const result = await service.claimGuestAccount(
      'g1',
      'ada',
      'Ada@Example.com',
      'a-real-password',
    );

    expect(db.user.create).not.toHaveBeenCalled();
    const args = db.user.update.mock.calls[0][0] as {
      where: { id: string; isGuest: boolean };
      data: { isGuest: boolean; email: string; password: string };
    };
    expect(args.where).toEqual({ id: 'g1', isGuest: true });
    expect(args.data.isGuest).toBe(false);
    expect(result.id).toBe('g1');
  });

  it('narrows the update by isGuest too, not just by id', async () => {
    // Belt and braces against the check-then-act window: the row is read,
    // then written, and the guard has to be in the WRITE or a race can
    // slip a full account through it.
    const { db, service } = claiming();
    await service.claimGuestAccount('g1', 'ada', 'a@b.co', 'a-real-password');
    const args = db.user.update.mock.calls[0][0] as {
      where: { isGuest: boolean };
    };
    expect(args.where.isGuest).toBe(true);
  });

  it('stores the address folded to lower case, and hashed credentials', async () => {
    const { db, service } = claiming();
    await service.claimGuestAccount(
      'g1',
      'ada',
      '  Ada@Example.COM ',
      'a-real-password',
    );
    const args = db.user.update.mock.calls[0][0] as {
      data: { email: string; password: string };
    };
    expect(args.data.email).toBe('ada@example.com');
    expect(args.data.password).not.toBe('a-real-password');
    expect(await bcrypt.compare('a-real-password', args.data.password)).toBe(
      true,
    );
  });

  it('refuses when the row is already a full account', async () => {
    // A stolen token must not be able to overwrite someone's credentials,
    // so the guard is on the ROW - the token cannot be trusted to report
    // this about itself.
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ id: 'u1', isGuest: false });
    await expect(
      serviceWith(db).claimGuestAccount(
        'u1',
        'ada',
        'a@b.co',
        'a-real-password',
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses to keep the unroutable address the guest was born with', async () => {
    const { db, service } = claiming();
    await expect(
      service.claimGuestAccount(
        'g1',
        'ada',
        'x@guest.invalid',
        'a-real-password',
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a short password, a bad name and a bad address', async () => {
    const { service } = claiming();
    await expect(
      service.claimGuestAccount('g1', 'ada', 'a@b.co', 'short'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.claimGuestAccount('g1', 'a b', 'a@b.co', 'a-real-password'),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.claimGuestAccount(
        'g1',
        'ada',
        'not-an-address',
        'a-real-password',
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('turns a lost race into a conflict rather than a 500', async () => {
    // findFirst said the name was free; between that and the write someone
    // else took it. The database is the only thing that can arbitrate.
    const { db, service } = claiming();
    db.user.update.mockRejectedValue(uniqueViolation('username'));
    await expect(
      service.claimGuestAccount('g1', 'ada', 'a@b.co', 'a-real-password'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses a name already taken, before writing anything', async () => {
    const { db, service } = claiming();
    db.user.findFirst.mockResolvedValue({ id: 'someone-else' });
    await expect(
      service.claimGuestAccount('g1', 'ada', 'a@b.co', 'a-real-password'),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('issues a fresh token, because the guest name is about to be wrong', async () => {
    const { service } = claiming();
    const result = await service.claimGuestAccount(
      'g1',
      'ada',
      'a@b.co',
      'a-real-password',
    );
    expect(jwtService.decode(result.token)).toMatchObject({
      sub: 'g1',
      name: 'ada',
    });
  });
});
