import { InMemoryRoomStateStore } from './room-state.store';
import type { Timeline } from '../shared/sync-protocol';
import { checkChain } from '../shared/sync-core/replay';

/**
 * Video fencing + set-video on the in-memory store: the same contract the
 * Lua scripts implement, so CI without Redis exercises the ordering
 * decisions formal/SyncSetVideo.tla pinned. Each test here is a transcribed
 * spec trace; the redis spec re-runs the same traces against the real Lua.
 */
describe('InMemoryRoomStateStore — set-video and the video fence', () => {
  const now = 1_700_000_000_000;

  const playingRoom = async (
    store: InMemoryRoomStateStore,
    room: string,
    videoId = 'video-A',
  ): Promise<Timeline> => {
    await store.init(room, videoId, 0, now);
    const played = await store.applyControl(room, 'play', 0, now + 1, 'host');
    return (played as { timeline: Timeline }).timeline;
  };

  it('set-video commits the new video in the canonical fresh state: paused at 0', async () => {
    const store = new InMemoryRoomStateStore();
    const before = await playingRoom(store, 'r1');

    const out = await store.applyControl(
      'r1',
      'set-video',
      0,
      now + 2,
      'host',
      { videoId: 'video-B' },
    );
    expect(out.kind).toBe('committed');
    const tl = (out as { timeline: Timeline }).timeline;
    expect(tl.videoId).toBe('video-B');
    expect(tl.isPlaying).toBe(false);
    expect(tl.mediaTime).toBe(0);
    expect(tl.reason).toBe('set-video');
    expect(tl.seq).toBe(before.seq + 1);
    // the transition is legal under the replay checker's contract
    expect(checkChain(store.getLog('r1')).violations).toEqual([]);
  });

  it('a position command minted against the old video is fenced, not applied', async () => {
    const store = new InMemoryRoomStateStore();
    await playingRoom(store, 'r2');
    await store.applyControl('r2', 'set-video', 0, now + 2, 'host', {
      videoId: 'video-B',
    });
    const current = (await store.get('r2'))!;

    // the seek was minted while its sender still saw video-A
    const out = await store.applyControl('r2', 'seek', 2220, now + 3, 'u2', {
      cmdId: 'stale-seek',
      forVideoId: 'video-A',
    });
    expect(out.kind).toBe('fenced');
    // nothing committed: the answer is the CURRENT state for a re-anchor
    expect((out as { timeline: Timeline }).timeline.seq).toBe(current.seq);
    expect((await store.get('r2'))!.seq).toBe(current.seq);
  });

  it('dup lookup runs BEFORE the fence: an applied command retried after a switch answers duplicate', async () => {
    const store = new InMemoryRoomStateStore();
    await playingRoom(store, 'r3');

    const first = await store.applyControl('r3', 'seek', 40, now + 2, 'u1', {
      cmdId: 'seek-1',
      forVideoId: 'video-A',
    });
    expect(first.kind).toBe('committed');

    await store.applyControl('r3', 'set-video', 0, now + 3, 'host', {
      videoId: 'video-B',
    });

    // the retry's fence is stale now - but the command DID apply, and the
    // truthful answer is duplicate, not stale-video
    const retry = await store.applyControl('r3', 'seek', 40, now + 4, 'u1', {
      cmdId: 'seek-1',
      forVideoId: 'video-A',
    });
    expect(retry.kind).toBe('duplicate');
  });

  it('a fenced command does not burn its id (formal/SyncSetVideo.tla, earlyrecord)', async () => {
    const store = new InMemoryRoomStateStore();
    await playingRoom(store, 'r4');
    await store.applyControl('r4', 'set-video', 0, now + 2, 'host', {
      videoId: 'video-B',
    });

    // fenced: minted against video-A, room shows video-B
    const fenced = await store.applyControl('r4', 'seek', 40, now + 3, 'u1', {
      cmdId: 'seek-2',
      forVideoId: 'video-A',
    });
    expect(fenced.kind).toBe('fenced');

    // the room switches BACK; the retry of the same id must now APPLY -
    // an early-recorded id would answer "duplicate" for a command that
    // never ran
    await store.applyControl('r4', 'set-video', 0, now + 4, 'host', {
      videoId: 'video-A',
    });
    const retry = await store.applyControl('r4', 'seek', 40, now + 5, 'u1', {
      cmdId: 'seek-2',
      forVideoId: 'video-A',
    });
    expect(retry.kind).toBe('committed');
  });

  it('an unfenced command keeps legacy semantics across a switch', async () => {
    const store = new InMemoryRoomStateStore();
    await playingRoom(store, 'r5');
    await store.applyControl('r5', 'set-video', 0, now + 2, 'host', {
      videoId: 'video-B',
    });
    // no forVideoId: wire compat - old clients are never fenced
    const out = await store.applyControl('r5', 'seek', 40, now + 3, 'u1');
    expect(out.kind).toBe('committed');
  });

  it('set-video itself is never fenced: switching is last-writer-wins', async () => {
    const store = new InMemoryRoomStateStore();
    await playingRoom(store, 'r6');
    await store.applyControl('r6', 'set-video', 0, now + 2, 'host', {
      videoId: 'video-B',
    });
    // a second switcher who still saw video-A is not refused - a "stale"
    // switch is still exactly what its sender meant
    const out = await store.applyControl('r6', 'set-video', 0, now + 3, 'u2', {
      videoId: 'video-C',
      forVideoId: 'video-A',
    });
    expect(out.kind).toBe('committed');
    expect((out as { timeline: Timeline }).timeline.videoId).toBe('video-C');
  });
});
