import { Timeline } from '../sync-protocol';
import { applyControl, isNewer, projectMediaTime, snapshot } from './timeline';

const base: Timeline = {
  v: 1,
  seq: 5,
  storeEpoch: '1000',
  videoId: 'vid',
  isPlaying: true,
  mediaTime: 100,
  stampedAt: 50_000,
  rate: 1,
  reason: 'play',
};

describe('projectMediaTime', () => {
  it('advances by elapsed server time while playing', () => {
    expect(projectMediaTime(base, 60_000)).toBeCloseTo(110, 9);
  });

  it('is frozen while paused', () => {
    const paused: Timeline = { ...base, isPlaying: false };
    expect(projectMediaTime(paused, 90_000)).toBe(100);
  });
});

describe('applyControl', () => {
  it('play restamps at server now from the commanded position', () => {
    const next = applyControl(base, 'play', 42, 70_000, 'u1');
    expect(next).toMatchObject({
      isPlaying: true,
      mediaTime: 42,
      stampedAt: 70_000,
      reason: 'play',
      by: 'u1',
    });
  });

  it("pause freezes at the commander's frozen mediaTime (P4)", () => {
    // the commander saw 103.2 when pressing pause; projection at receipt
    // would be ~110 — the frame the presser saw wins
    const next = applyControl(base, 'pause', 103.2, 60_000, 'u1');
    expect(next.isPlaying).toBe(false);
    expect(next.mediaTime).toBe(103.2);
  });

  it('seek preserves playing state', () => {
    const playingSeek = applyControl(base, 'seek', 300, 60_000, 'u1');
    expect(playingSeek.isPlaying).toBe(true);
    expect(playingSeek.mediaTime).toBe(300);
    const pausedSeek = applyControl(
      { ...base, isPlaying: false },
      'seek',
      300,
      60_000,
      'u1',
    );
    expect(pausedSeek.isPlaying).toBe(false);
  });
});

describe('snapshot', () => {
  it('re-anchors the projection without changing state', () => {
    const snap = snapshot(base, 60_000);
    expect(snap.mediaTime).toBeCloseTo(110, 9);
    expect(snap.stampedAt).toBe(60_000);
    expect(snap.isPlaying).toBe(true);
    expect(snap.reason).toBe('snapshot');
  });
});

describe('isNewer', () => {
  it('accepts anything when nothing applied yet', () => {
    expect(isNewer(base, null)).toBe(true);
  });

  it('same epoch: strictly higher seq wins', () => {
    expect(isNewer({ ...base, seq: 6 }, base)).toBe(true);
    expect(isNewer({ ...base, seq: 5 }, base)).toBe(false);
    expect(isNewer({ ...base, seq: 4 }, base)).toBe(false);
  });

  it('a NEWER epoch wins regardless of seq (store rehydration)', () => {
    expect(isNewer({ ...base, storeEpoch: '2000', seq: 0 }, base)).toBe(true);
  });

  it('a STALE pre-flush broadcast is dropped (the TLC counterexample)', () => {
    // client already on the post-flush epoch; the old epoch's message
    // arrives late via pub/sub reordering - must not regress
    const postFlush = { ...base, storeEpoch: '2000', seq: 1 };
    expect(isNewer({ ...base, storeEpoch: '500', seq: 9 }, postFlush)).toBe(
      false,
    );
  });
});
