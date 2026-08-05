import Redis from 'ioredis';
import { RedisRoomStateStore } from './redis-room-state.store';
import { SWEEP_DEDUP_PERIOD_MS } from './room-state.store';

/**
 * The repair sweep against a REAL Redis, because the dedup lives in
 * apply_snapshot.lua and a mock would prove nothing about it.
 *
 * Every instance holding a local socket in a room runs its own 10s sweep
 * timer, so on a 3-instance lab the room was swept three times per period:
 * three seq bumps and three fanouts for one repair, scaling linearly with
 * instance count. The three commits also raced, and clients received them out
 * of order often enough that the bot fleet's gap counter recorded 59 "gaps"
 * on the three-instance 25-client cell. Nothing was ever lost — the metric
 * counted reordering as loss — but the redundant sweeps were real.
 *
 * Skipped automatically when no Redis is reachable.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const key = (room: string): string => `room:${room}:tl`;

describe('RedisRoomStateStore — repair sweep dedup', () => {
  const clients: Redis[] = [];
  let available = true;
  const room = `sweep-test-${Date.now().toString(36)}`;

  const raw = (): Redis => {
    const c = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(c);
    return c;
  };

  const make = (): RedisRoomStateStore => {
    const kv = new Redis(URL, { maxRetriesPerRequest: 1, lazyConnect: false });
    clients.push(kv);
    return new RedisRoomStateStore(kv);
  };

  beforeAll(async () => {
    try {
      const probe = new Redis(URL, {
        maxRetriesPerRequest: 1,
        // without a bound, an unreachable Redis leaves ioredis retrying and
        // the suite hangs on the probe instead of skipping
        connectTimeout: 2_000,
        retryStrategy: () => null,
        lazyConnect: true,
      });
      clients.push(probe);
      probe.on('error', () => undefined);
      await Promise.race([
        probe.connect().then(() => probe.ping()),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), 3_000),
        ),
      ]);
    } catch {
      available = false;
    }
  }, 10_000);

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  const playingRoom = async (
    store: RedisRoomStateStore,
    name: string,
  ): Promise<void> => {
    await store.init(name, 'vid', 0, Date.now());
    await store.applyControl(name, 'play', 0, Date.now(), 'u1');
  };

  it('commits once however many instances call it at the same moment', async () => {
    if (!available) return;
    // three stores standing in for three instances, all sharing one Redis
    const a = make();
    const b = make();
    const c = make();
    await playingRoom(a, room);

    const before = await a.get(room);
    expect(before).not.toBeNull();

    const results = await Promise.all([
      a.applySnapshot(room, Date.now()),
      b.applySnapshot(room, Date.now()),
      c.applySnapshot(room, Date.now()),
    ]);

    // one winner; the losers return null so their callers skip broadcasting
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const after = await a.get(room);
    expect(after!.seq).toBe(before!.seq + 1);
  });

  it('suppresses a STAGGERED second caller inside the same window', async () => {
    if (!available) return;
    // The case an elapsed-time guard gets wrong: two instances whose timers
    // are offset by nearly a full period. With a 9s "minimum interval" a
    // sweep at t=0 and another at t=9.5s both commit, which is two bumps
    // inside one 10s period. Aligned windows reject the second.
    const a = make();
    const b = make();
    const staggered = `${room}-staggered`;
    await playingRoom(a, staggered);

    const first = await a.applySnapshot(staggered, Date.now());
    expect(first).not.toBeNull();

    // put the committed window's clock near the end of the same window
    const w = Math.floor(Date.now() / SWEEP_DEDUP_PERIOD_MS);
    await raw().hset(key(staggered), 'lastSweepWindow', String(w));

    expect(await b.applySnapshot(staggered, Date.now())).toBeNull();
    const after = await a.get(staggered);
    expect(after!.seq).toBe(first!.seq);
  });

  it('lets the next window through', async () => {
    if (!available) return;
    const a = make();
    const next = `${room}-next`;
    await playingRoom(a, next);

    const first = await a.applySnapshot(next, Date.now());
    expect(first).not.toBeNull();
    // immediately after, the guard suppresses
    expect(await a.applySnapshot(next, Date.now())).toBeNull();

    // ...but the guard must not wedge the repair channel shut. Rather than
    // sleep out a real period, put the room in an earlier window.
    const w = Math.floor(Date.now() / SWEEP_DEDUP_PERIOD_MS);
    await raw().hset(key(next), 'lastSweepWindow', String(w - 1));

    const second = await a.applySnapshot(next, Date.now());
    expect(second).not.toBeNull();
    expect(second!.seq).toBe(first!.seq + 1);
  });

  it('never advances a paused room', async () => {
    if (!available) return;
    const a = make();
    const paused = `${room}-paused`;
    await a.init(paused, 'vid', 0, Date.now()); // init always restores paused (P5)

    const before = await a.get(paused);
    // TimelineService.sweepSnapshot short-circuits paused rooms before it ever
    // gets here, so the script's own contract is the weaker one: it hands back
    // the unchanged state rather than null. What must hold at this layer is
    // that a paused room is never advanced.
    const swept = await a.applySnapshot(paused, Date.now());
    expect(swept?.isPlaying).toBe(false);
    const after = await a.get(paused);
    expect(after!.seq).toBe(before!.seq);
    expect(after!.mediaTime).toBe(before!.mediaTime);
  });
});
