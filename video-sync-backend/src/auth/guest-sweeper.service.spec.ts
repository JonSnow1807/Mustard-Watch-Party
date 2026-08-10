import { GuestSweeperService } from './guest-sweeper.service';
import { DatabaseService } from '../database/database.service';

const makeDb = () => ({
  user: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
});

/** The shape the sweeper passes to Prisma, so the assertions are checked. */
interface DeleteArgs {
  where: {
    isGuest: boolean;
    createdAt: { lt: Date };
    roomsCreated: unknown;
    participants: unknown;
    chatMessages: unknown;
  };
}

const deleteWhere = (db: ReturnType<typeof makeDb>): DeleteArgs['where'] =>
  (db.user.deleteMany.mock.calls as DeleteArgs[][])[0][0].where;

const sweeperWith = (db: ReturnType<typeof makeDb>) =>
  new GuestSweeperService(db as unknown as DatabaseService);

const NOW = new Date('2026-08-10T00:00:00Z').getTime();

describe('GuestSweeperService', () => {
  it('only ever deletes guests, and only old ones', () => {
    const db = makeDb();
    void sweeperWith(db).sweep(NOW);

    const where = deleteWhere(db);
    expect(where.isGuest).toBe(true);
    // a week back, not a day: a guest in yesterday's room should still have
    // a name in that room's chat history tomorrow
    expect(NOW - where.createdAt.lt.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('spares any guest who left a trace someone else can still see', () => {
    const db = makeDb();
    void sweeperWith(db).sweep(NOW);

    const where = deleteWhere(db);
    // each of these is load-bearing for another person's screen
    expect(where.roomsCreated).toEqual({ none: {} });
    expect(where.participants).toEqual({ none: {} });
    expect(where.chatMessages).toEqual({ none: {} });
  });

  it('reports what it removed', async () => {
    const db = makeDb();
    db.user.deleteMany.mockResolvedValue({ count: 3 });
    await expect(sweeperWith(db).sweep(NOW)).resolves.toBe(3);
  });

  it('survives a failing sweep rather than taking the process down', async () => {
    // the rows are inert and the next run finds them again; a nightly job
    // that can crash the API is a worse problem than a few stale guests
    const db = makeDb();
    db.user.deleteMany.mockRejectedValue(new Error('connection reset'));
    await expect(sweeperWith(db).sweep(NOW)).resolves.toBe(0);
  });
});
