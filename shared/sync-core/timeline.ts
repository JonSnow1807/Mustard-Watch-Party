import { ControlIntent, Timeline } from '../sync-protocol';

/** Project the media position (seconds) at a server-domain instant. */
export function projectMediaTime(tl: Timeline, serverNow: number): number {
  if (!tl.isPlaying) return tl.mediaTime;
  return tl.mediaTime + ((serverNow - tl.stampedAt) / 1000) * tl.rate;
}

/**
 * Ordering rule for applying received timelines. Epochs are TOTALLY ORDERED
 * (minted from the store clock domain at rehydration): higher epoch wins;
 * same epoch, higher seq wins; anything else is stale and dropped.
 *
 * Model-checked (formal/SyncTimeline.tla): the earlier "different epoch
 * always wins" rule let a stale pre-flush broadcast, delivered after the
 * post-flush one, regress a client — and dead-epoch memory cannot fix it
 * because a never-seen epoch is unclassifiable without ordering.
 */
export function isNewer(incoming: Timeline, applied: Timeline | null): boolean {
  if (applied === null) return true;
  const a = Number(incoming.storeEpoch);
  const b = Number(applied.storeEpoch);
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return a > b;
  if (incoming.storeEpoch !== applied.storeEpoch) return a > b; // NaN-safe: reject unorderable
  return incoming.seq > applied.seq;
}

/**
 * Restamp a control intent into a new timeline at server time `serverNow`.
 * Pure: seq assignment/persistence belong to the state store, which calls
 * this and commits the result atomically.
 *
 * Semantics (design doc P1–P5):
 * - play: start playing from the commanded position, epoch = now
 * - pause: freeze at the commander's frozen mediaTime ("the frame I saw"),
 *   NOT the projected position — projecting forward would pause at a frame
 *   the presser never saw (P4)
 * - seek: jump to the commanded position, playing state unchanged
 */
export function applyControl(
  prev: Timeline,
  intent: ControlIntent,
  mediaTime: number,
  serverNow: number,
  by: string,
): Omit<Timeline, 'seq'> {
  const base = {
    v: 1 as const,
    storeEpoch: prev.storeEpoch,
    videoId: prev.videoId,
    rate: 1 as const,
    stampedAt: serverNow,
    by,
  };
  switch (intent) {
    case 'play':
      return { ...base, isPlaying: true, mediaTime, reason: 'play' };
    case 'pause':
      return { ...base, isPlaying: false, mediaTime, reason: 'pause' };
    case 'seek':
      return {
        ...base,
        isPlaying: prev.isPlaying,
        mediaTime,
        reason: 'seek',
      };
  }
}

/** A server-time snapshot re-anchors the projection without changing state. */
export function snapshot(
  tl: Timeline,
  serverNow: number,
): Omit<Timeline, 'seq'> {
  return {
    v: 1,
    storeEpoch: tl.storeEpoch,
    videoId: tl.videoId,
    isPlaying: tl.isPlaying,
    mediaTime: projectMediaTime(tl, serverNow),
    stampedAt: serverNow,
    rate: 1,
    reason: 'snapshot',
  };
}
