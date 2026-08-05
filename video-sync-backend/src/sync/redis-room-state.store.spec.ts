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
 * on the three-instance 25-client cell. No seq inside any bot's observed
 * range actually went unreceived — the metric counted reordering as loss —
 * but the redundant sweeps were real.
 *
 * Skipped automatically when no Redis is reachable.
 */
const URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const key = (room: string): string => `room:${room}:tl`;

/**
 * The guard lives in Lua and derives its window from `redis.call('TIME')`, so
 * every window this spec computes must come from the SAME clock. Seeding from
 * the test host's `Date.now()` reaches across clock domains — the one thing
 * D6 forbids — and makes these assertions flaky at window boundaries.
 */
const redisNowMs = async (c: Redis): Promise<number> => {
  const [sec, usec] = await c.time();
  return Number(sec) * 1000 + Math.floor(Number(usec) / 1000);
};

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
    let timer: ReturnType<typeof setTimeout> | undefined;
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
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('probe timeout')), 3_000);
        }),
      ]);
    } catch {
      available = false;
    } finally {
      // the loser of the race is still pending: leaving its timer armed keeps
      // the event loop alive and delays Jest's exit on every short run
      if (timer) clearTimeout(timer);
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
    // A caller arriving late into a window another instance already claimed.
    // Staged to look 9.5s old so the assertion is about WINDOW IDENTITY and
    // not about the calls being milliseconds apart.
    //
    // Note on what this does and does not separate: an elapsed-time guard
    // whose threshold equals the period is indistinguishable from the window
    // guard on same-window cases, because within one window elapsed is always
    // < period by construction. The two only diverge when the threshold is
    // BELOW the period (the original 9s), which is what let a staggered
    // caller through. The test that actually goes red on the old guard is
    // 'lets the next window through' — verified by checking out the previous
    // apply_snapshot.lua and re-running this file.
    const a = make();
    const b = make();
    const c = raw();
    const staggered = `${room}-staggered`;
    await playingRoom(a, staggered);

    const first = await a.applySnapshot(staggered, await redisNowMs(c));
    expect(first).not.toBeNull();

    const now = await redisNowMs(c);
    await c.hset(
      key(staggered),
      // the window is claimed...
      'lastSweepWindow',
      String(Math.floor(now / SWEEP_DEDUP_PERIOD_MS)),
      // ...but the last sweep looks 9.5s old, so a 9s elapsed threshold passes
      'lastSweepAt',
      String(now - 9_500),
    );

    expect(await b.applySnapshot(staggered, now)).toBeNull();
    const after = await a.get(staggered);
    expect(after!.seq).toBe(first!.seq);
  });

  it('lets the next window through', async () => {
    if (!available) return;
    const a = make();
    const c = raw();
    const next = `${room}-next`;
    await playingRoom(a, next);

    const first = await a.applySnapshot(next, await redisNowMs(c));
    expect(first).not.toBeNull();
    // immediately after, the guard suppresses
    expect(await a.applySnapshot(next, await redisNowMs(c))).toBeNull();

    // ...but the guard must not wedge the repair channel shut. Rather than
    // sleep out a real period, put the room in an earlier window — computed
    // from Redis's clock, the same one the script reads.
    //
    // This assertion is the suite's regression tripwire: it is decided purely
    // by window identity, so the elapsed-time guard fails it (that guard sees
    // a commit milliseconds old and suppresses regardless of window).
    const w = Math.floor((await redisNowMs(c)) / SWEEP_DEDUP_PERIOD_MS);
    await c.hset(key(next), 'lastSweepWindow', String(w - 1));

    const second = await a.applySnapshot(next, await redisNowMs(c));
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
