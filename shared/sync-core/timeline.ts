import { ControlIntent, Timeline } from '../sync-protocol';

/** Project the media position (seconds) at a server-domain instant. */
export function projectMediaTime(tl: Timeline, serverNow: number): number {
  if (!tl.isPlaying) return tl.mediaTime;
  return tl.mediaTime + ((serverNow - tl.stampedAt) / 1000) * tl.rate;
}

/**
 * Ordering rule for applying received timelines. Same epoch: strictly higher
 * seq wins. Different epoch: the incoming one wins — an epoch only changes
 * when the authoritative store was rehydrated, which is by definition newer
 * than anything from the old epoch (see protocol note on fencing).
 */
export function isNewer(incoming: Timeline, applied: Timeline | null): boolean {
  if (applied === null) return true;
  if (incoming.storeEpoch !== applied.storeEpoch) return true;
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
