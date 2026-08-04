import Redis from 'ioredis';
import { RedisRoomStateStore } from './redis-room-state.store';
import { SWEEP_MIN_INTERVAL_MS } from './room-state.store';

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

describe('RedisRoomStateStore — repair sweep dedup', () => {
  const clients: Redis[] = [];
  let available = true;
  const room = `sweep-test-${Date.now().toString(36)}`;

  const make = (): RedisRoomStateStore => {
    const kv = new Redis(URL, { maxRetriesPerRequest: 1, lazyConnect: false });
    clients.push(kv);
    return new RedisRoomStateStore(kv);
  };

  beforeAll(async () => {
    try {
      const probe = new Redis(URL, { maxRetriesPerRequest: 1 });
      clients.push(probe);
      await probe.ping();
    } catch {
      available = false;
    }
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it('commits at most one sweep per period however many instances call it', async () => {
    if (!available) return;
    // three stores standing in for three instances, all sharing one Redis
    const a = make();
    const b = make();
    const c = make();

    await a.init(room, 'vid', 0, Date.now());
    await a.applyControl(room, 'play', 0, Date.now(), 'u1');

    const before = await a.get(room);
    expect(before).not.toBeNull();

    // all three sweep "simultaneously", exactly as the timers do in the lab
    const results = await Promise.all([
      a.applySnapshot(room, Date.now()),
      b.applySnapshot(room, Date.now()),
      c.applySnapshot(room, Date.now()),
    ]);

    const committed = results.filter((r) => r !== null);
    // one winner; the losers return null so their callers skip broadcasting
    expect(committed).toHaveLength(1);

    const after = await a.get(room);
    // exactly one seq bump, not three
    expect(after!.seq).toBe(before!.seq + 1);
  });

  it('lets the next period through', async () => {
    if (!available) return;
    const a = make();
    const roomB = `${room}-next`;
    await a.init(roomB, 'vid', 0, Date.now());
    await a.applyControl(roomB, 'play', 0, Date.now(), 'u1');

    const first = await a.applySnapshot(roomB, Date.now());
    expect(first).not.toBeNull();

    // immediately after, the guard suppresses
    expect(await a.applySnapshot(roomB, Date.now())).toBeNull();

    // ...but the guard must not wedge the repair channel shut. Rather than
    // sleep out the real interval, wind lastSweepAt back past it.
    const kv = new Redis(URL, { maxRetriesPerRequest: 1 });
    clients.push(kv);
    await kv.hset(
      `room:${roomB}:tl`,
      'lastSweepAt',
      String(Date.now() - SWEEP_MIN_INTERVAL_MS - 1_000),
    );

    const second = await a.applySnapshot(roomB, Date.now());
    expect(second).not.toBeNull();
    expect(second!.seq).toBe(first!.seq + 1);
  });

  it('never advances a paused room', async () => {
    if (!available) return;
    const a = make();
    const roomP = `${room}-paused`;
    await a.init(roomP, 'vid', 0, Date.now()); // init always restores paused (P5)

    const before = await a.get(roomP);
    // TimelineService.sweepSnapshot short-circuits paused rooms before it ever
    // gets here, so the script's own contract is the weaker one: it hands back
    // the unchanged state rather than null. What must hold at this layer is
    // that a paused room is never advanced.
    const swept = await a.applySnapshot(roomP, Date.now());
    expect(swept?.isPlaying).toBe(false);
    const after = await a.get(roomP);
    expect(after!.seq).toBe(before!.seq);
    expect(after!.mediaTime).toBe(before!.mediaTime);
  });
});
