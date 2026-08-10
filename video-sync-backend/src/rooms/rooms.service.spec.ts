import { RoomsService } from './rooms.service';
import { DatabaseService } from '../database/database.service';

/**
 * The rule this file exists to enforce: a query that reaches a client must
 * never ask Prisma for a User relation WHOLESALE.
 *
 * Prisma returns every scalar of a relation pulled with
 * `include: { creator: true }` - and User.password is a scalar. That is how
 * GET /api/rooms/:code came to hand any caller holding a room code the
 * creator's bcrypt hash and email, in production, unauthenticated. The bug
 * is invisible at the call site: nothing in `include: { creator: true }`
 * mentions a password.
 *
 * So the assertion is on the QUERY, not the response. Asserting on a
 * response proves nothing here - the response is whatever the mock returns.
 * Asserting on the arguments proves the service asked the database to
 * narrow, which is the only thing that actually protects the field.
 */

/** Every User scalar that must never be requested for somebody else. */
const FORBIDDEN_USER_FIELDS = ['password', 'email'];

/**
 * Walk a Prisma query argument tree and collect every violation: a user
 * relation included wholesale (`true`), or narrowed by a select that still
 * asks for a forbidden field.
 */
function violations(node: unknown, path: string[] = []): string[] {
  if (node === null || typeof node !== 'object') return [];
  const found: string[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    const here = [...path, key];
    const isUserRelation = key === 'creator' || key === 'user';

    if (isUserRelation) {
      if (value === true) {
        found.push(
          `${here.join('.')}: included wholesale (pulls every User scalar, password included)`,
        );
        continue;
      }
      if (value && typeof value === 'object') {
        const select = (value as { select?: Record<string, unknown> }).select;
        if (!select) {
          found.push(`${here.join('.')}: no select (pulls every User scalar)`);
        } else {
          for (const field of FORBIDDEN_USER_FIELDS) {
            if (select[field]) {
              found.push(`${here.join('.')}.select.${field}: requested`);
            }
          }
        }
      }
    }
    found.push(...violations(value, here));
  }
  return found;
}

/**
 * The gateway only exists here to receive the room-closed announcement; the
 * broadcast itself is the gateway's business, not this suite's.
 */
const announcer = () => ({ announceRoomClosed: jest.fn() });

describe("RoomsService - no query hands a client another user's secrets", () => {
  const room = {
    id: 'room-1',
    code: 'CODE1',
    creatorId: 'user-1',
    participants: [],
  };

  /** Records the argument every Prisma call receives so we can inspect it. */
  const calls: Array<{ op: string; args: unknown }> = [];
  const record = (op: string, result: unknown) => (args: unknown) => {
    calls.push({ op, args });
    return Promise.resolve(result);
  };

  const database = {
    room: {
      findUnique: jest.fn(record('room.findUnique', room)),
      findMany: jest.fn(record('room.findMany', [room])),
      create: jest.fn(record('room.create', room)),
      update: jest.fn(record('room.update', room)),
      delete: jest.fn(record('room.delete', room)),
    },
    participant: {
      findMany: jest.fn(record('participant.findMany', [])),
      updateMany: jest.fn(record('participant.updateMany', { count: 0 })),
      deleteMany: jest.fn(record('participant.deleteMany', { count: 0 })),
    },
    chatMessage: {
      findMany: jest.fn(record('chatMessage.findMany', [])),
      deleteMany: jest.fn(record('chatMessage.deleteMany', { count: 0 })),
    },
    syncEvent: {
      deleteMany: jest.fn(record('syncEvent.deleteMany', { count: 0 })),
    },
  } as unknown as DatabaseService;

  const service = new RoomsService(database, announcer() as never);

  beforeEach(() => {
    calls.length = 0;
  });

  const readPaths: Array<[string, () => Promise<unknown>]> = [
    ['getRoomByCode', () => service.getRoomByCode('CODE1')],
    ['getPublicRooms', () => service.getPublicRooms()],
    ['getUserRooms', () => service.getUserRooms('user-1')],
    [
      'createRoom',
      () => service.createRoom('user-1', 'a room', undefined, false),
    ],
  ];

  it.each(readPaths)(
    "%s never requests another user's password or email",
    async (_name, run) => {
      await run().catch(() => undefined); // shape of the call is the assertion
      expect(calls.length).toBeGreaterThan(0);
      const found = calls.flatMap((c) =>
        violations(c.args).map((v) => `${c.op} -> ${v}`),
      );
      expect(found).toEqual([]);
    },
  );

  it('the guard itself catches the bug that shipped', () => {
    // the exact shape that leaked in production, so a future refactor that
    // reintroduces it fails here rather than in the wild
    expect(violations({ include: { creator: true } })).toEqual([
      'include.creator: included wholesale (pulls every User scalar, password included)',
    ]);
    expect(
      violations({ include: { user: { select: { id: true, email: true } } } }),
    ).toEqual(['include.user.select.email: requested']);
    // and does not fire on the narrowed form we want everywhere
    expect(
      violations({
        include: { creator: { select: { id: true, username: true } } },
      }),
    ).toEqual([]);
  });
});

describe('ending a room says goodbye to the people in it', () => {
  const roomRow = {
    id: 'r1',
    code: 'ABC123',
    creatorId: 'owner',
    creator: { id: 'owner', username: 'ada' },
    participants: [],
  };

  const setup = () => {
    const sync = announcer();
    const database = {
      room: {
        findUnique: jest.fn().mockResolvedValue(roomRow),
        delete: jest.fn().mockResolvedValue(roomRow),
      },
      chatMessage: { deleteMany: jest.fn() },
      syncEvent: { deleteMany: jest.fn() },
      participant: { deleteMany: jest.fn() },
      $transaction: jest.fn((fn: (tx: unknown) => unknown) =>
        fn({
          chatMessage: { deleteMany: jest.fn() },
          syncEvent: { deleteMany: jest.fn() },
          participant: { deleteMany: jest.fn() },
          room: { delete: jest.fn() },
        }),
      ),
    };
    return { sync, database };
  };

  it('announces the closure to the room', async () => {
    const { sync, database } = setup();
    await new RoomsService(database as never, sync as never).deleteRoom(
      'ABC123',
      'owner',
    );
    expect(sync.announceRoomClosed).toHaveBeenCalledWith('ABC123');
  });

  it('says nothing when the caller is not the creator', async () => {
    // a refused delete must not tell a room it is closing
    const { sync, database } = setup();
    await expect(
      new RoomsService(database as never, sync as never).deleteRoom(
        'ABC123',
        'someone-else',
      ),
    ).rejects.toThrow();
    expect(sync.announceRoomClosed).not.toHaveBeenCalled();
  });

  it('says nothing when the room does not exist', async () => {
    const { sync, database } = setup();
    database.room.findUnique.mockResolvedValue(null);
    await expect(
      new RoomsService(database as never, sync as never).deleteRoom(
        'NOPE',
        'owner',
      ),
    ).rejects.toThrow();
    expect(sync.announceRoomClosed).not.toHaveBeenCalled();
  });
});
