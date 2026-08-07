// GENERATED FILE — do not edit here.
// Canonical source: /shared/. Regenerate: node scripts/sync-shared.mjs
import { ControlIntent, Timeline } from '../sync-protocol';
import { projectMediaTime } from './timeline';

/**
 * One committed transition, as appended (atomically with the commit) to the
 * per-room append-only log by every Lua commit script and the InMemory
 * store. Entries are FULL post-states, so the log is a transition relation:
 * replay does not need to re-execute anything, and every consecutive pair
 * can be checked against the intent contract independently of the code that
 * produced it.
 *
 * This is formal/SyncExactlyOnce.tla transferred to the implementation:
 * `checkChain` is TransitionContract, `entryMatchesLive` is
 * ReplayReconstructs - and the spec's nosnaplog config is why snapshot
 * commits MUST be logged (they bump seq and re-anchor the projection; a log
 * without them cannot rebuild live state and reconciliation would report
 * phantom drift).
 */
export interface LogEntry {
  seq: number;
  storeEpoch: string;
  videoId: string | null;
  isPlaying: boolean;
  mediaTime: number;
  stampedAt: number;
  reason: string;
  by?: string;
  cmdId?: string;
}

const CONTROL_REASONS: ReadonlySet<string> = new Set(['play', 'pause', 'seek']);

/** float slack for the snapshot projection (Lua string arithmetic). */
const EPS = 1e-6;

/**
 * NaN fails every > comparison, so `Math.abs(a-b) > EPS` reports a
 * non-finite value as LEGAL - the one way a corrupt entry could pass this
 * checker silently. Every float comparison goes through here instead.
 */
const differs = (a: number, b: number): boolean =>
  !Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > EPS;

/**
 * The legal-transition contract between two consecutive same-epoch entries,
 * written INDEPENDENTLY of applyControl/snapshot - double-entry bookkeeping,
 * exactly like the spec's Contract vs Apply split. Returns a violation
 * description, or null when legal.
 */
export function checkTransition(prev: LogEntry, next: LogEntry): string | null {
  if (next.storeEpoch !== prev.storeEpoch) {
    return null; // epoch boundaries are anchored by init entries, not chained
  }
  if (next.seq !== prev.seq + 1) {
    return `seq ${prev.seq} -> ${next.seq}: not contiguous`;
  }
  if (next.stampedAt < prev.stampedAt) {
    return `stampedAt regressed ${prev.stampedAt} -> ${next.stampedAt}`;
  }
  if (next.reason === 'set-video') {
    // the ONE transition allowed to change videoId - and it must land in
    // the canonical fresh state: paused at 0 (a new video never autoplays)
    if (next.isPlaying) {
      return 'set-video committed a playing state';
    }
    if (differs(next.mediaTime, 0)) {
      return `set-video committed mediaTime ${next.mediaTime}, not 0`;
    }
    return null;
  }
  if (next.videoId !== prev.videoId) {
    return `videoId changed mid-epoch (${prev.videoId} -> ${next.videoId})`;
  }
  if (CONTROL_REASONS.has(next.reason)) {
    const intent = next.reason as ControlIntent;
    if (intent === 'play' && !next.isPlaying) {
      return 'play committed a non-playing state';
    }
    if (intent === 'pause' && next.isPlaying) {
      return 'pause committed a playing state';
    }
    if (intent === 'seek' && next.isPlaying !== prev.isPlaying) {
      return 'seek flipped isPlaying';
    }
    return null; // mediaTime is the commanded position - any value is legal
  }
  if (next.reason === 'snapshot') {
    if (next.isPlaying !== prev.isPlaying) {
      return 'snapshot flipped isPlaying';
    }
    const projected = projectMediaTime({ ...toTimeline(prev) }, next.stampedAt);
    if (differs(next.mediaTime, projected)) {
      return `snapshot moved the projection: expected ${projected}, logged ${next.mediaTime}`;
    }
    return null;
  }
  return `unknown transition reason '${next.reason}'`;
}

export function toTimeline(e: LogEntry): Timeline {
  return {
    v: 1,
    seq: e.seq,
    storeEpoch: e.storeEpoch,
    videoId: e.videoId,
    isPlaying: e.isPlaying,
    mediaTime: e.mediaTime,
    stampedAt: e.stampedAt,
    rate: 1,
    reason: e.reason as Timeline['reason'],
    by: e.by || undefined,
  };
}

export interface ChainReport {
  checked: number;
  violations: string[];
}

/**
 * Validate every consecutive pair in stream order. The log is trimmed
 * (MAXLEN ~), so the chain is anchored at the OLDEST RETAINED entry - a
 * truncated head is expected and legal; a hole or an illegal transition
 * inside the retained window is not.
 */
export function checkChain(entries: LogEntry[]): ChainReport {
  const violations: string[] = [];
  for (let i = 1; i < entries.length; i++) {
    const v = checkTransition(entries[i - 1], entries[i]);
    if (v) violations.push(`entry ${i} (seq ${entries[i].seq}): ${v}`);
  }
  return { checked: Math.max(0, entries.length - 1), violations };
}

/**
 * ReplayReconstructs: the newest retained log entry must BE the live state.
 * Any disagreement is drift between what was committed and what is served.
 */
export function entryMatchesLive(
  last: LogEntry,
  live: Timeline,
): string | null {
  if (last.storeEpoch !== live.storeEpoch) {
    return `epoch: log ${last.storeEpoch} vs live ${live.storeEpoch}`;
  }
  if (last.seq !== live.seq) {
    return `seq: log ${last.seq} vs live ${live.seq}`;
  }
  if (last.isPlaying !== live.isPlaying) {
    return `isPlaying: log ${last.isPlaying} vs live ${live.isPlaying}`;
  }
  if (differs(last.mediaTime, live.mediaTime)) {
    return `mediaTime: log ${last.mediaTime} vs live ${live.mediaTime}`;
  }
  if (last.reason !== live.reason) {
    return `reason: log ${last.reason} vs live ${live.reason}`;
  }
  if (last.stampedAt !== live.stampedAt) {
    return `stampedAt: log ${last.stampedAt} vs live ${live.stampedAt}`;
  }
  if ((last.videoId ?? null) !== (live.videoId ?? null)) {
    return `videoId: log ${last.videoId} vs live ${live.videoId}`;
  }
  return null;
}
