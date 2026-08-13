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
    create: jest.fn().mockResolvedValue(undefined),
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

/** Revocations double: records bumps, revokes nothing on its own. */
const makeRevocations = () =>
  ({
    revokeToken: jest.fn().mockResolvedValue(undefined),
    noteVersionBumped: jest.fn().mockResolvedValue(undefined),
  }) as unknown as import('./revocation.service').RevocationService;

const serviceWith = (
  db: ReturnType<typeof makeDb>,
  revocations = makeRevocations(),
) => new AuthService(db as unknown as DatabaseService, jwtService, revocations);

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
    const args = (
      db.user.update.mock.calls as [
        {
          where: { id: string; isGuest: boolean };
          data: { isGuest: boolean; email: string; password: string };
        },
      ][]
    )[0][0];
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
    const args = (
      db.user.update.mock.calls as [{ where: { isGuest: boolean } }][]
    )[0][0];
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
    const args = (
      db.user.update.mock.calls as [
        { data: { email: string; password: string } },
      ][]
    )[0][0];
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

describe('both doors into the users table enforce the same rules', () => {
  // register went a long time checking nothing while claimGuestAccount
  // checked three things. These run the same table against both, because a
  // rule that only one door knows about is not a rule.
  const bad: [string, string, string, string][] = [
    ['a short password', 'ada', 'ada@example.com', 'short12'],
    [
      'a name with a space',
      'ada lovelace',
      'ada@example.com',
      'a-real-password',
    ],
    ['a name of two characters', 'ad', 'ada@example.com', 'a-real-password'],
    ['an address with no domain', 'ada', 'ada@localhost', 'a-real-password'],
    ['the guest address', 'ada', 'x@guest.invalid', 'a-real-password'],
  ];

  describe.each(bad)('%s', (_label, username, email, password) => {
    it('is refused by register, before anything is written', async () => {
      const db = makeDb();
      await expect(
        serviceWith(db).register(username, email, password),
      ).rejects.toMatchObject({ status: 400 });
      expect(db.user.create).not.toHaveBeenCalled();
    });

    it('is refused by claim, before anything is written', async () => {
      const db = makeDb();
      db.user.findUnique.mockResolvedValue({ id: 'g1', isGuest: true });
      await expect(
        serviceWith(db).claimGuestAccount('g1', username, email, password),
      ).rejects.toMatchObject({ status: 400 });
      expect(db.user.update).not.toHaveBeenCalled();
    });
  });

  it('stores what it validated, not what it was handed', async () => {
    // validating a trimmed, lower-cased string and then writing the raw one
    // would make the check decorative
    const db = makeDb();
    db.user.create.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      email: 'ada@example.com',
    });
    await serviceWith(db).register(
      '  ada  ',
      '  Ada@Example.COM ',
      'a-real-password',
    );
    const args = (
      db.user.create.mock.calls as [
        { data: { username: string; email: string } },
      ][]
    )[0][0];
    expect(args.data.username).toBe('ada');
    expect(args.data.email).toBe('ada@example.com');
  });
});

describe('attaching Google to a guest', () => {
  const guestRow = { id: 'g1', isGuest: true };

  const linking = () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(guestRow);
    db.user.update.mockResolvedValue({
      id: 'g1',
      username: 'ada_lovelace',
      email: 'ada@example.com',
    });
    return { db, service: serviceWith(db) };
  };

  it('updates the guest row in place and links the provider', async () => {
    const { db, service } = linking();
    const result = await service.linkGoogleToGuest('g1', identity);

    expect(db.user.create).not.toHaveBeenCalled();
    const args = (
      db.user.update.mock.calls as [
        {
          where: { id: string; isGuest: boolean };
          data: {
            isGuest: boolean;
            oauthAccounts: { create: { providerAccountId: string } };
          };
        },
      ][]
    )[0][0];
    expect(args.where).toEqual({ id: 'g1', isGuest: true });
    expect(args.data.isGuest).toBe(false);
    expect(args.data.oauthAccounts.create.providerAccountId).toBe(
      'google-sub-123',
    );
    expect(result.id).toBe('g1');
  });

  it('leaves the password null, so the only way in is the provider', async () => {
    const { db, service } = linking();
    await service.linkGoogleToGuest('g1', identity);
    const args = (
      db.user.update.mock.calls as [{ data: Record<string, unknown> }][]
    )[0][0];
    expect(args.data.password).toBeUndefined();
  });

  it('refuses a Google account already attached to someone else', async () => {
    // the takeover this guards: grafting a real user's Google identity onto
    // a guest row would hand the guest that person's way in
    const { db, service } = linking();
    db.oAuthAccount.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(
      service.linkGoogleToGuest('g1', identity),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses when the address already belongs to another account', async () => {
    const { db, service } = linking();
    db.user.findFirst.mockResolvedValue({ id: 'someone-else' });
    await expect(
      service.linkGoogleToGuest('g1', identity),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('refuses a row that is already a full account', async () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({ id: 'u1', isGuest: false });
    await expect(
      serviceWith(db).linkGoogleToGuest('u1', identity),
    ).rejects.toMatchObject({ status: 403 });
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it('walks past a taken name rather than failing', async () => {
    const { db, service } = linking();
    db.user.update
      .mockRejectedValueOnce(uniqueViolation('username'))
      .mockResolvedValueOnce({
        id: 'g1',
        username: 'ada_lovelace2',
        email: 'a@b.co',
      });
    const result = await service.linkGoogleToGuest('g1', identity);
    expect(result.username).toBe('ada_lovelace2');
    expect(db.user.update).toHaveBeenCalledTimes(2);
  });

  it('turns a lost race on the provider link into a conflict, not a 500', async () => {
    const { db, service } = linking();
    db.user.update.mockRejectedValue(uniqueViolation('providerAccountId'));
    await expect(
      service.linkGoogleToGuest('g1', identity),
    ).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe('refreshing a session', () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  /** decode() defaults to any; the generic names what this suite reads -
   *  and unlike an `as` cast, eslint --fix cannot strip it. */
  const claims = (t: string) =>
    jwtService.decode<{ jti: string; ver: number; sess: number }>(t);

  const refreshing = () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      tokenVersion: 2,
    });
    const revocations = makeRevocations();
    return { db, revocations, service: serviceWith(db, revocations) };
  };

  it('rotates: new jti, old token revoked in the same call', async () => {
    const { service, revocations } = refreshing();
    const out = await service.refreshSession({
      sub: 'u1',
      jti: 'j-old',
      ver: 2,
      sess: nowS() - 3600,
      exp: nowS() + 1000,
    });

    const decoded = claims(out.token);
    expect(decoded.jti).not.toBe('j-old');
    expect(decoded.ver).toBe(2);
    const [jti, userId] = (revocations.revokeToken as jest.Mock).mock
      .calls[0] as [string, string];
    expect(jti).toBe('j-old');
    expect(userId).toBe('u1');
  });

  it('preserves the session birth verbatim - the cap must not slide', async () => {
    const { service } = refreshing();
    const birth = nowS() - 5 * 24 * 3600;
    const out = await service.refreshSession({
      sub: 'u1',
      jti: 'j1',
      sess: birth,
    });
    expect(claims(out.token).sess).toBe(birth);
  });

  it('refuses a session past thirty days, however fresh its token', async () => {
    // the whole point of anchoring to birth: a token refreshed every 11
    // hours is perpetually young; the SESSION is not
    const { service, revocations } = refreshing();
    await expect(
      service.refreshSession({
        sub: 'u1',
        jti: 'j1',
        sess: nowS() - 31 * 24 * 3600,
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect((revocations.revokeToken as jest.Mock).mock.calls).toHaveLength(0);
  });

  it('anchors a pre-sess token to its own iat, not to now', async () => {
    // anchoring to now would grant every legacy token a fresh 30 days on
    // first refresh - a cap that resets is not a cap
    const { service } = refreshing();
    const iat = nowS() - 40 * 24 * 3600;
    await expect(
      service.refreshSession({ sub: 'u1', jti: 'j1', iat }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('still refreshes a legacy token with no jti - it just cannot revoke it', async () => {
    const { service, revocations } = refreshing();
    const out = await service.refreshSession({ sub: 'u1', sess: nowS() - 60 });
    expect(typeof out.token).toBe('string');
    expect((revocations.revokeToken as jest.Mock).mock.calls).toHaveLength(0);
  });
});

describe('linking Google to a FULL account', () => {
  const linking = () => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      email: 'ada@example.com',
      tokenVersion: 0,
    });
    return { db, service: serviceWith(db) };
  };

  it('adds the provider row and touches nothing else about the account', async () => {
    // the guest path rewrites identity because a guest has none worth
    // keeping; a full account's name and email are THEIRS
    const { db, service } = linking();
    const out = await service.linkGoogleToFull('u1', identity);
    expect(db.user.update).not.toHaveBeenCalled();
    expect(db.oAuthAccount.create).toHaveBeenCalledWith({
      data: {
        provider: 'google',
        providerAccountId: 'google-sub-123',
        userId: 'u1',
      },
    });
    expect(out.username).toBe('ada');
  });

  it('refuses a Google account already linked to someone else', async () => {
    const { db, service } = linking();
    db.oAuthAccount.findUnique.mockResolvedValue({ userId: 'someone-else' });
    await expect(
      service.linkGoogleToFull('u1', identity),
    ).rejects.toMatchObject({ status: 409 });
    expect(db.oAuthAccount.create).not.toHaveBeenCalled();
  });

  it('is idempotent when already linked to THIS account', async () => {
    // a double-submitted flow should not scold the person it worked for
    const { db, service } = linking();
    db.oAuthAccount.findUnique.mockResolvedValue({ userId: 'u1' });
    const out = await service.linkGoogleToFull('u1', identity);
    expect(db.oAuthAccount.create).not.toHaveBeenCalled();
    expect(typeof out.token).toBe('string');
  });
});

describe('setting a password', () => {
  it('writes the hash and bumps the version in ONE database write', async () => {
    // the bump ending every other session must be atomic with the new
    // hash: two writes leave a window where the password changed but the
    // attacker's token still works
    const db = makeDb();
    const revocations = makeRevocations();
    db.user.update.mockResolvedValue({
      id: 'u1',
      username: 'ada',
      email: 'a@b.co',
      tokenVersion: 3,
    });
    const service = serviceWith(db, revocations);
    const out = await service.setPassword('u1', 'a-new-password');

    const args = (
      db.user.update.mock.calls as [
        { data: { password: unknown; tokenVersion: unknown } },
      ][]
    )[0][0];
    expect(typeof args.data.password).toBe('string');
    expect(args.data.tokenVersion).toEqual({ increment: 1 });
    expect((revocations.noteVersionBumped as jest.Mock).mock.calls).toEqual([
      ['u1', 3],
    ]);
    // the caller continues on a token AT the new version
    expect(jwtService.decode<{ ver: number }>(out.token).ver).toBe(3);
  });

  it('refuses a short password before writing anything', async () => {
    const db = makeDb();
    await expect(
      serviceWith(db).setPassword('u1', 'short'),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.user.update).not.toHaveBeenCalled();
  });
});

describe('which re-auth gate an account needs', () => {
  const withUser = (row: unknown) => {
    const db = makeDb();
    db.user.findUnique.mockResolvedValue(row);
    return serviceWith(db);
  };

  it('password accounts verify their password', async () => {
    await expect(
      withUser({ password: 'hash', oauthAccounts: [] }).reauthMethodFor('u1'),
    ).resolves.toBe('password');
  });

  it('provider-only accounts re-run Google', async () => {
    await expect(
      withUser({
        password: null,
        oauthAccounts: [{ provider: 'google' }],
      }).reauthMethodFor('u1'),
    ).resolves.toBe('google');
  });

  it('guests have neither, which callers must treat as its own case', async () => {
    await expect(
      withUser({ password: null, oauthAccounts: [] }).reauthMethodFor('u1'),
    ).resolves.toBeNull();
  });

  it('verifyPassword treats no-password-on-file as refusal, never a pass', async () => {
    // an account that cannot be verified this way needs the OAuth gate;
    // returning true here would make the weakest accounts the easiest to take
    await expect(
      withUser({ password: null }).verifyPassword('u1', 'anything'),
    ).resolves.toBe(false);
  });
});
