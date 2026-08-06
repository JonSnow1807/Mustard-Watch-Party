import Redis from 'ioredis';
import { ActorRoomStateStore } from './actor-room-state.store';

/**
 * Fencing proofs against a REAL Redis (the Lua guard is the mechanism under
 * test, so a mock would prove nothing). These are the implementation-level
 * counterparts of the properties TLC checks in formal/SyncActor.tla.
 * Skipped automatically when no Redis is reachable.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

describe('ActorRoomStateStore — lease fencing', () => {
  let a: ActorRoomStateStore;
  let b: ActorRoomStateStore;
  const clients: Redis[] = [];
  let available = true;
  const room = `actor-test-${Date.now().toString(36)}`;

  const make = (id: string): ActorRoomStateStore => {
    process.env.INSTANCE_ID = id;
    const kv = new Redis(URL, { maxRetriesPerRequest: 1, lazyConnect: false });
    const pub = new Redis(URL, { maxRetriesPerRequest: 1 });
    const sub = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(kv, pub, sub);
    return new ActorRoomStateStore(kv, pub, sub);
  };

  beforeAll(async () => {
    try {
      const probe = new Redis(URL, { maxRetriesPerRequest: 1 });
      await probe.ping();
      await probe.quit();
    } catch {
      available = false;
      return;
    }
    a = make('inst-a');
    b = make('inst-b');
  });

  afterAll(async () => {
    if (!available) return;
    a?.onApplicationShutdown();
    b?.onApplicationShutdown();
    await a?.clear(room).catch(() => undefined);
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it('serializes concurrent controls for one room (no stale-state commit)', async () => {
    if (!available) return;
    const r = `${room}-serial`;
    await a.init(r, 'vid', 0, Date.now());
    await a.applyControl(r, 'play', 100, Date.now(), 'u1');
    // fire concurrently: without the per-room queue both would derive from
    // the same in-memory timeline and the second would commit stale state
    const outcomes = await Promise.all([
      a.applyControl(r, 'pause', 0, Date.now(), 'u1'),
      a.applyControl(r, 'play', 0, Date.now(), 'u1'),
      a.applyControl(r, 'pause', 0, Date.now(), 'u1'),
    ]);
    const seqs = outcomes
      .filter((o) => o.kind === 'committed')
      .map((o) => (o as { timeline: { seq: number } }).timeline.seq);
    expect(seqs.length).toBe(3);
    expect(new Set(seqs).size).toBe(3); // strictly distinct
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs); // and in order
    await a.clear(r);
  });

  it('one instance owns a room; the other forwards instead of writing', async () => {
    if (!available) return;
    await a.init(room, 'vid', 0, Date.now());
    const first = await a.applyControl(room, 'play', 10, Date.now(), 'u1');
    expect(first.kind).toBe('committed');
    // b has never owned this room, so its control must be forwarded
    const second = await b.applyControl(room, 'seek', 99, Date.now(), 'u2');
    expect(second.kind).toBe('forwarded');
    // and b must NOT have written anything
    const state = await b.get(room);
    expect(state?.mediaTime).toBe(10);
  });

  it('a zombie commit under a stale fence is rejected (NoStaleFenceWrite)', async () => {
    if (!available) return;
    const zombieRoom = `${room}-zombie`;
    await a.init(zombieRoom, 'vid', 0, Date.now());
    await a.applyControl(zombieRoom, 'play', 5, Date.now(), 'u1');
    expect(a.ownedRooms()).toContain(zombieRoom);

    // simulate a: crashed long enough for the lease to expire, and b claimed
    const kv = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(kv);
    await kv.del(`room:${zombieRoom}:lease`);
    const claimed = await b.applyControl(
      zombieRoom,
      'seek',
      42,
      Date.now(),
      'u2',
    );
    expect(claimed.kind).toBe('committed');

    // a wakes up still believing it owns the room: its commit must be fenced
    const zombie = await a.applyControl(
      zombieRoom,
      'seek',
      777,
      Date.now(),
      'u1',
    );
    // the zombie's WRITE is rejected (that is NoStaleFenceWrite); its user's
    // intent is then forwarded to the real owner rather than dropped
    expect(zombie.kind).not.toBe('committed');
    expect(zombie.kind).toBe('forwarded');
    expect(a.ownedRooms()).not.toContain(zombieRoom); // and it learned it lost
    const state = await b.get(zombieRoom);
    expect(state?.mediaTime).toBe(42); // b's write survived, 777 never landed
    await b.clear(zombieRoom);
  });

  it('a cmdId applied by the OLD owner is a duplicate to the NEW owner', async () => {
    if (!available) return;
    // The handoff race the exactly-once spec surfaced: the dedup record must
    // be fence-independent and live in Redis, or an owner change forgets
    // every applied command and a redelivered forward re-applies.
    const r = `${room}-dedup-handoff`;
    await a.init(r, 'vid', 0, Date.now());
    const first = await a.applyControl(
      r,
      'seek',
      10,
      Date.now(),
      'u1',
      'cmd-h1',
    );
    expect(first.kind).toBe('committed');

    // owner change: a's lease dies, b claims on its next control
    const kv = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(kv);
    await kv.del(`room:${r}:lease`);
    const claim = await b.applyControl(
      r,
      'play',
      20,
      Date.now(),
      'u2',
      'cmd-h2',
    );
    expect(claim.kind).toBe('committed');
    const seqAfterClaim = (await b.get(r))!.seq;

    // the redelivered forward of the OLD owner's command reaches the NEW
    // owner (the forward publish is redeliverable) - it must dedup, not apply
    const replay = await b.applyControl(
      r,
      'seek',
      10,
      Date.now(),
      'u1',
      'cmd-h1',
    );
    expect(replay.kind).toBe('duplicate');
    expect((await b.get(r))!.seq).toBe(seqAfterClaim);
    await b.clear(r);
  });

  it('the fence advances on ownership change, so clients still order correctly', async () => {
    if (!available) return;
    const r = `${room}-epoch`;
    await a.init(r, 'vid', 0, Date.now());
    const beforeOutcome = await a.applyControl(r, 'play', 1, Date.now(), 'u1');
    const before =
      beforeOutcome.kind === 'committed' ? beforeOutcome.timeline : null;
    const kv = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(kv);
    await kv.del(`room:${r}:lease`);
    const afterOutcome = await b.applyControl(r, 'seek', 2, Date.now(), 'u2');
    const after =
      afterOutcome.kind === 'committed' ? afterOutcome.timeline : null;
    expect(before && after).toBeTruthy();
    // a NEW owner mints a higher epoch, so the ordered client rule accepts it
    expect(Number(after!.storeEpoch)).toBeGreaterThan(
      Number(before!.storeEpoch),
    );
    expect(after!.seq).toBe(1); // seq restarts within the new fence
    await b.clear(r);
  });
});
