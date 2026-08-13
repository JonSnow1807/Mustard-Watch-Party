import { RevocationService } from './revocation.service';
import type { DatabaseService } from '../database/database.service';
import type { TokenPayload } from './token-payload';

const makeDb = (
  tokens: { jti: string }[] = [],
  users: { id: string; tokenVersion: number }[] = [],
) => ({
  revokedToken: {
    findMany: jest.fn().mockResolvedValue(tokens),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  },
  user: {
    findMany: jest.fn().mockResolvedValue(users),
    update: jest.fn().mockResolvedValue({ tokenVersion: 1 }),
  },
});

const service = async (db: ReturnType<typeof makeDb>, kv: unknown = null) => {
  const s = new RevocationService(
    db as unknown as DatabaseService,
    null,
    null,
    kv as never,
  );
  await s.refresh();
  return s;
};

/** An ioredis double that records what the mirror writes. */
const makeKv = () => {
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return kv; // multi chains
    };
  const kv: Record<string, unknown> = {
    calls,
    multi: () => kv,
    del: record('del'),
    sadd: record('sadd'),
    hset: record('hset'),
    rename: record('rename'),
    exec: () => {
      calls.push(['exec']);
      return Promise.resolve([]);
    },
  };
  return kv as unknown as {
    calls: unknown[][];
  };
};

const token = (over: Partial<TokenPayload> = {}): TokenPayload => ({
  sub: 'u1',
  name: 'ada',
  jti: 'j1',
  ver: 0,
  ...over,
});

describe('what the snapshot refuses', () => {
  it('lets an untouched token through', async () => {
    const s = await service(makeDb());
    expect(s.isRevoked(token())).toBeNull();
  });

  it('refuses a token whose jti was revoked', async () => {
    const s = await service(makeDb([{ jti: 'j1' }]));
    expect(s.isRevoked(token())).toBe('token');
    // and only that one - revoking a session must not sign out the others
    expect(s.isRevoked(token({ jti: 'j2' }))).toBeNull();
  });

  it('refuses a token issued under an older version', async () => {
    const s = await service(makeDb([], [{ id: 'u1', tokenVersion: 3 }]));
    expect(s.isRevoked(token({ ver: 2 }))).toBe('user');
    expect(s.isRevoked(token({ ver: 3 }))).toBeNull();
    // a token issued AFTER the bump is newer, not staler
    expect(s.isRevoked(token({ ver: 4 }))).toBeNull();
  });

  it('treats a missing version as 0, so old tokens keep working', async () => {
    // Tokens minted before this feature existed carry no ver. They are not
    // suspicious, they are just old, and refusing them would sign out
    // everyone the moment this deployed.
    const s = await service(makeDb());
    const noVer: TokenPayload = { sub: 'u1', name: 'ada', jti: 'j1' };
    expect(s.isRevoked(noVer)).toBeNull();
  });

  it('refuses a malformed version rather than reading it as 0', async () => {
    // 0 is the version everyone starts at, so treating a nonsense claim as 0
    // would let a token argue its way back past a revocation.
    const s = await service(makeDb([], [{ id: 'u1', tokenVersion: 2 }]));
    expect(s.isRevoked(token({ ver: 'nope' } as unknown as TokenPayload))).toBe(
      'user',
    );
    expect(s.isRevoked(token({ ver: -1 }))).toBe('user');
    expect(s.isRevoked(token({ ver: 1.5 }))).toBe('user');
  });

  it('refuses everything until the first load has finished', () => {
    // An empty snapshot and a loaded-empty snapshot look identical, and
    // answering "not revoked" from the first is a confident lie. This window
    // is one instance booting; refusing is the safe side and the caller
    // retries.
    const s = new RevocationService(
      makeDb() as unknown as DatabaseService,
      null,
      null,
      null,
    );
    expect(s.isRevoked(token())).toBe('user');
  });
});

describe('when the database is unreachable', () => {
  it('keeps the previous snapshot rather than emptying it', async () => {
    // An empty snapshot trusts every revoked token. A stale one only misses
    // revocations made since it was taken - strictly the better failure.
    const db = makeDb([{ jti: 'j1' }]);
    const s = await service(db);
    expect(s.isRevoked(token())).toBe('token');

    db.revokedToken.findMany.mockRejectedValue(new Error('down'));
    await s.refresh();
    expect(s.isRevoked(token())).toBe('token');
  });
});

describe('revoking', () => {
  it('writes the record before trusting its own memory', async () => {
    // Revocation that forgets on restart is not revocation. Postgres is the
    // truth; the in-memory set is a cache of it.
    const db = makeDb();
    const s = await service(db);
    const expires = new Date(Date.now() + 3600_000);

    await s.revokeToken('j1', 'u1', expires);

    expect(db.revokedToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jti: 'j1' },
        create: { jti: 'j1', userId: 'u1', expiresAt: expires },
      }),
    );
    expect(s.isRevoked(token())).toBe('token');
  });

  it('takes effect on this instance immediately, with no Redis at all', async () => {
    // Redis carries the news to OTHER instances. A deployment without it is
    // a single instance, where the news has nowhere to go and the local set
    // is the whole story.
    const s = await service(makeDb());
    await s.revokeAllForUser('u1');
    expect(s.isRevoked(token({ ver: 0 }))).toBe('user');
  });

  it('bumps the version rather than setting it, so two revocations both count', async () => {
    const db = makeDb();
    const s = await service(db);
    await s.revokeAllForUser('u1');
    const args = (
      db.user.update.mock.calls as [{ data: { tokenVersion: unknown } }][]
    )[0][0];
    expect(args.data.tokenVersion).toEqual({ increment: 1 });
  });

  it('tells listeners, so live sockets can be closed', async () => {
    const s = await service(makeDb());
    const seen: unknown[] = [];
    s.onEvent((e) => seen.push(e));
    await s.revokeToken('j9', 'u1', new Date(Date.now() + 1000));
    expect(seen).toEqual([{ kind: 'token', jti: 'j9' }]);
  });

  it('survives a listener that throws', async () => {
    // One badly behaved handler must not stop the revocation from being
    // announced to the others, or from having happened at all.
    const s = await service(makeDb());
    s.onEvent(() => {
      throw new Error('boom');
    });
    const seen: unknown[] = [];
    s.onEvent((e) => seen.push(e));
    await expect(
      s.revokeToken('j9', 'u1', new Date(Date.now() + 1000)),
    ).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
  });
});

describe('the sweep', () => {
  it('deletes only records past the expiry of the token they refuse', async () => {
    // A token past its own expiry is refused by the signature check before
    // this is consulted, so the record can never match again.
    const db = makeDb();
    const s = await service(db);
    const now = new Date('2026-08-13T00:00:00Z');
    await s.sweep(now);
    expect(db.revokedToken.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: now } },
    });
  });

  it('does not take the process down when it fails', async () => {
    const db = makeDb();
    const s = await service(db);
    db.revokedToken.deleteMany.mockRejectedValue(new Error('down'));
    await expect(s.sweep()).resolves.toBe(0);
  });
});

describe('a revocation that lands while a refresh is in flight', () => {
  it('survives the refresh instead of being thrown away', async () => {
    // refresh() reads from Postgres and then replaces the snapshot. Anything
    // revoked between the read and the replacement used to be discarded by
    // that assignment and accepted until the next tick - which contradicts
    // the one guarantee this makes about its own instance.
    const db = makeDb();
    const s = await service(db);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    db.revokedToken.findMany.mockImplementation(async () => {
      await held; // the read has happened; the assignment has not
      return [];
    });

    const refreshing = s.refresh();
    await s.revokeToken('j-late', 'u1', new Date(Date.now() + 3600_000));
    release();
    await refreshing;

    expect(s.isRevoked(token({ jti: 'j-late' }))).toBe('token');
  });

  it('keeps the higher version rather than the one the query returned', async () => {
    const db = makeDb();
    const s = await service(db);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    db.user.findMany.mockImplementation(async () => {
      await held;
      return [{ id: 'u1', tokenVersion: 0 }];
    });

    const refreshing = s.refresh();
    db.user.update.mockResolvedValue({ tokenVersion: 5 });
    await s.revokeAllForUser('u1');
    release();
    await refreshing;

    expect(s.isRevoked(token({ ver: 4 }))).toBe('user');
  });
});

describe('two refreshes overlapping', () => {
  it("does not let the second one drop the first one's revocations", async () => {
    // The pending buffers and the refreshing flag are shared state. Two
    // overlapping refreshes clear each other's buffers, and the first to
    // finish turns the flag off for the one still running - which puts back
    // exactly the dropped-revocation bug the buffers exist to prevent. A
    // slow query and a 30s timer is all it takes.
    const db = makeDb();
    const s = await service(db);

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    db.revokedToken.findMany.mockImplementation(async () => {
      calls++;
      await held;
      return [];
    });

    const first = s.refresh();
    const second = s.refresh(); // arrives while the first is still reading
    await s.revokeToken('j-late', 'u1', new Date(Date.now() + 3600_000));
    release();
    await Promise.all([first, second]);

    expect(s.isRevoked(token({ jti: 'j-late' }))).toBe('token');
    // and the second call joined the first rather than starting its own
    expect(calls).toBe(1);
  });
});

describe('a malformed announcement from another instance', () => {
  const applyEvent = (s: RevocationService, raw: string) =>
    (s as unknown as { applyEvent(r: string): void }).applyEvent(raw);

  it('does not un-revoke a user by omitting the version', async () => {
    // 0 is the version every account starts at, so falling back to it turns
    // a truncated message into an un-revocation.
    const s = await service(makeDb([], [{ id: 'u1', tokenVersion: 3 }]));
    expect(s.isRevoked(token({ ver: 1 }))).toBe('user');

    applyEvent(s, JSON.stringify({ kind: 'user', userId: 'u1' }));
    expect(s.isRevoked(token({ ver: 1 }))).toBe('user');
  });

  it('never moves a stored version backwards', async () => {
    const s = await service(makeDb([], [{ id: 'u1', tokenVersion: 3 }]));
    applyEvent(s, JSON.stringify({ kind: 'user', userId: 'u1', version: 1 }));
    expect(s.isRevoked(token({ ver: 2 }))).toBe('user');
  });

  it('ignores nonsense without throwing', async () => {
    const s = await service(makeDb());
    expect(() => applyEvent(s, 'not json')).not.toThrow();
    expect(() => applyEvent(s, JSON.stringify({ kind: 'wat' }))).not.toThrow();
  });
});

describe('the Redis mirror, which is how the relay learns', () => {
  it('rebuilds under temp keys and swaps with RENAME, never in place', async () => {
    // A reader mid-rebuild must not see a half-written set: a relay that
    // reads between DEL and SADD would briefly trust revoked tokens.
    const kv = makeKv();
    await service(makeDb([{ jti: 'j1' }], [{ id: 'u1', tokenVersion: 2 }]), kv);

    expect(kv.calls).toEqual([
      ['del', 'revoked:jti:tmp', 'revoked:userver:tmp'],
      ['sadd', 'revoked:jti:tmp', 'j1'],
      ['rename', 'revoked:jti:tmp', 'revoked:jti'],
      ['hset', 'revoked:userver:tmp', 'u1', '2'],
      ['rename', 'revoked:userver:tmp', 'revoked:userver'],
      ['exec'],
    ]);
  });

  it('DELs the live keys when nothing is revoked - RENAME of nothing throws', async () => {
    const kv = makeKv();
    await service(makeDb(), kv);
    expect(kv.calls).toEqual([
      ['del', 'revoked:jti:tmp', 'revoked:userver:tmp'],
      ['del', 'revoked:jti'],
      ['del', 'revoked:userver'],
      ['exec'],
    ]);
  });

  it('mirrors a single revocation immediately, not on the next refresh', async () => {
    // The pub/sub message and the mirror write travel together: a relay
    // that misses the message still reads the SADD on its next poll, and
    // one that gets the message can trust the mirror is already updated.
    const kv = makeKv();
    const s = await service(makeDb(), kv);
    kv.calls.length = 0;

    await s.revokeToken('j9', 'u1', new Date(Date.now() + 3600_000));
    expect(kv.calls).toContainEqual(['sadd', 'revoked:jti', 'j9']);

    await s.revokeAllForUser('u1');
    expect(kv.calls).toContainEqual(['hset', 'revoked:userver', 'u1', '1']);
  });

  it('works with no Redis at all - the mirror is optional, the truth is not', async () => {
    const s = await service(makeDb());
    await expect(
      s.revokeToken('j1', 'u1', new Date(Date.now() + 1000)),
    ).resolves.toBeUndefined();
  });

  it('a mirror failure does not fail the revocation', async () => {
    // The revocation is real once Postgres has it; the mirror is a cache.
    // Refusing to sign someone out because a cache write failed would be
    // backwards.
    const kv = makeKv();
    (kv as unknown as { sadd: () => never }).sadd = () => {
      throw new Error('redis down');
    };
    const s = await service(makeDb(), kv);
    await expect(
      s.revokeToken('j1', 'u1', new Date(Date.now() + 1000)),
    ).resolves.toBeUndefined();
    expect(s.isRevoked(token({ jti: 'j1' }))).toBe('token');
  });
});
