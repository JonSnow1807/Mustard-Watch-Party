import { InMemoryRoomStateStore } from './room-state.store';
import {
  checkChain,
  checkTransition,
  entryMatchesLive,
} from '../shared/sync-core/replay';

/**
 * The replay contract (formal/SyncExactlyOnce.tla: TransitionContract +
 * ReplayReconstructs) against the InMemory store's mirrored log - the same
 * checker the harness reconciler runs against the Redis streams, so the
 * CI-without-Redis path proves the identical semantics.
 */
describe('append-only log replay contract', () => {
  it('a real command sequence produces a legal chain that matches live', async () => {
    const store = new InMemoryRoomStateStore();
    const r = 'replay-room';
    await store.init(r, 'vid', 0, 1_000);
    await store.applyControl(r, 'play', 0, 2_000, 'u1', { cmdId: 'c1' });
    await store.applyControl(r, 'seek', 300, 3_000, 'u1', { cmdId: 'c2' });
    await store.applySnapshot(r, 5_000);
    await store.applyControl(r, 'pause', 305, 6_000, 'u1', { cmdId: 'c3' });

    const log = store.getLog(r);
    expect(log).toHaveLength(5); // init + 3 controls + 1 sweep - ALL logged

    const chain = checkChain(log);
    expect(chain.violations).toEqual([]);
    expect(chain.checked).toBe(4);

    const live = await store.get(r);
    expect(entryMatchesLive(log[log.length - 1], live!)).toBeNull();
  });

  it('a duplicate does not append - the log records commits, not deliveries', async () => {
    const store = new InMemoryRoomStateStore();
    const r = 'replay-dup';
    await store.init(r, 'vid', 0, 1_000);
    await store.applyControl(r, 'seek', 42, 2_000, 'u1', { cmdId: 'dup' });
    await store.applyControl(r, 'seek', 42, 3_000, 'u1', { cmdId: 'dup' });
    expect(store.getLog(r)).toHaveLength(2); // init + ONE commit
  });

  it('set-video is the one legal videoId change, held to its own contract', async () => {
    const store = new InMemoryRoomStateStore();
    const r = 'replay-setvideo';
    await store.init(r, 'vid', 0, 1_000);
    await store.applyControl(r, 'play', 0, 2_000, 'u1', { cmdId: 'c1' });
    await store.applyControl(r, 'set-video', 0, 3_000, 'u1', {
      cmdId: 'c2',
      videoId: 'vid-B',
    });
    await store.applyControl(r, 'play', 0, 4_000, 'u1', { cmdId: 'c3' });

    const log = store.getLog(r);
    const chain = checkChain(log);
    expect(chain.violations).toEqual([]);

    const base = {
      storeEpoch: '1000',
      videoId: 'vid',
      isPlaying: true,
      mediaTime: 100,
      stampedAt: 5_000,
      by: 'u1',
    };
    const prev = { ...base, seq: 3, reason: 'play' };
    // a set-video that commits playing state, or a nonzero position, breaks
    // the canonical-fresh-state contract
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'set-video',
        videoId: 'vid-B',
        isPlaying: true,
        mediaTime: 0,
        stampedAt: 6_000,
      }),
    ).toMatch(/playing state/);
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'set-video',
        videoId: 'vid-B',
        isPlaying: false,
        mediaTime: 37,
        stampedAt: 6_000,
      }),
    ).toMatch(/not 0/);
    // any OTHER reason changing videoId is still illegal
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'seek',
        videoId: 'vid-B',
        mediaTime: 200,
        stampedAt: 6_000,
      }),
    ).toMatch(/videoId changed mid-epoch/);
  });

  it('the contract catches what it exists to catch', () => {
    const base = {
      storeEpoch: '1000',
      videoId: 'vid',
      isPlaying: true,
      mediaTime: 100,
      stampedAt: 5_000,
      by: 'u1',
    };
    const prev = { ...base, seq: 3, reason: 'play' };
    // a seek that flips isPlaying - the double-entry check the spec transfers
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'seek',
        isPlaying: false,
        mediaTime: 200,
        stampedAt: 6_000,
      }),
    ).toMatch(/flipped isPlaying/);
    // a snapshot that moves the projection: playing at 100 anchored at 5s,
    // snapshotted at 7s must land at exactly 102
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'snapshot',
        mediaTime: 150,
        stampedAt: 7_000,
      }),
    ).toMatch(/moved the projection/);
    expect(
      checkTransition(prev, {
        ...base,
        seq: 4,
        reason: 'snapshot',
        mediaTime: 102,
        stampedAt: 7_000,
      }),
    ).toBeNull();
    // a hole in the chain
    expect(
      checkTransition(prev, {
        ...base,
        seq: 6,
        reason: 'pause',
        isPlaying: false,
        stampedAt: 6_000,
      }),
    ).toMatch(/not contiguous/);
  });
});
