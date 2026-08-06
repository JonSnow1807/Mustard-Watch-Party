// Replay-based reconciliation over the append-only command log: the
// event-sourcing half of the exactly-once work (SYNC_DESIGN 2b), and the
// live transfer of formal/SyncExactlyOnce.tla's two log properties -
// TransitionContract (every logged transition obeys its intent's contract)
// and ReplayReconstructs (the newest retained entry IS the live state).
//
//   npx tsx src/replay-check.ts [--redis redis://localhost:6380] [--gate]
//
// Reads every room:*:log stream, validates the retained chain, and compares
// the newest entry against the live room:*:tl hash. Reports a drift rate
// the way the harness reports percentiles: measured, per room, committable.
// The log is trimmed (MAXLEN ~1024), so chains anchor at the oldest
// retained entry - truncation is legal, holes are not.
import Redis from 'ioredis';
import {
  checkChain,
  entryMatchesLive,
  type LogEntry,
} from '../../shared/sync-core/replay';
import type { Timeline } from '../../shared/sync-protocol';

const arg = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const URL = arg('--redis') ?? process.env.REDIS_URL ?? 'redis://localhost:6380';
const GATE = process.argv.includes('--gate');

/** the report is a committable artifact: never let URI userinfo reach it */
const redacted = (u: string): string => u.replace(/\/\/[^@/]+@/, '//<redacted>@');

function fieldsToEntry(fields: string[]): LogEntry {
  const m = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) m.set(fields[i], fields[i + 1]);
  return {
    seq: Number(m.get('seq')),
    storeEpoch: m.get('storeEpoch') ?? '',
    videoId: m.get('videoId') || null,
    isPlaying: m.get('isPlaying') === '1',
    mediaTime: Number(m.get('mediaTime')),
    stampedAt: Number(m.get('stampedAt')),
    reason: m.get('reason') ?? '',
    by: m.get('by') || undefined,
    cmdId: m.get('cmdId') || undefined,
  };
}

function hashToTimeline(h: Record<string, string>): Timeline {
  return {
    v: 1,
    seq: Number(h.seq),
    storeEpoch: h.storeEpoch,
    videoId: h.videoId || null,
    isPlaying: h.isPlaying === '1',
    mediaTime: Number(h.mediaTime),
    stampedAt: Number(h.stampedAt),
    rate: 1,
    reason: h.reason as Timeline['reason'],
    by: h.by || undefined,
  };
}

async function main(): Promise<void> {
  const redis = new Redis(URL, { maxRetriesPerRequest: 2 });
  const logKeys: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      'room:*:log',
      'COUNT',
      200,
    );
    cursor = next;
    logKeys.push(...keys);
  } while (cursor !== '0');

  let rooms = 0;
  let entries = 0;
  let driftRooms = 0;
  const violations: string[] = [];
  for (const logKey of logKeys) {
    const room = logKey.slice('room:'.length, -':log'.length);
    const raw = (await redis.xrange(logKey, '-', '+')) as Array<
      [string, string[]]
    >;
    if (raw.length === 0) continue;
    rooms += 1;
    const log = raw.map(([, fields]) => fieldsToEntry(fields));
    entries += log.length;

    const chain = checkChain(log);
    for (const v of chain.violations) violations.push(`${room}: ${v}`);

    // XRANGE and HGETALL are separate commands, so a commit landing between
    // them yields a mixed-version pair and FALSE drift. Re-read the live
    // hash and retry the pair until its version is stable across the log
    // read - rooms commit a few times a minute, so one pass is the norm.
    let mismatch: string | null = null;
    let reconciled = false;
    for (let attempt = 0; attempt < 3 && !reconciled; attempt++) {
      const liveBefore = await redis.hgetall(`room:${room}:tl`);
      if (Object.keys(liveBefore).length === 0) {
        // timeline expired but the log survived: nothing to reconcile
        reconciled = true;
        mismatch = null;
        break;
      }
      const tail = (await redis.xrevrange(logKey, '+', '-', 'COUNT', 1)) as Array<
        [string, string[]]
      >;
      const liveAfter = await redis.hgetall(`room:${room}:tl`);
      if (
        liveBefore.storeEpoch !== liveAfter.storeEpoch ||
        liveBefore.seq !== liveAfter.seq
      ) {
        continue; // a commit raced the reads; retry the pair
      }
      const newest = tail.length > 0 ? fieldsToEntry(tail[0][1]) : log[log.length - 1];
      mismatch = entryMatchesLive(newest, hashToTimeline(liveAfter));
      reconciled = true;
    }
    if (!reconciled) {
      violations.push(`${room}: UNSTABLE - versions kept moving across 3 read attempts`);
    } else if (mismatch) {
      driftRooms += 1;
      violations.push(`${room}: LIVE DRIFT - ${mismatch}`);
    }
  }
  await redis.quit();

  const driftRate = rooms > 0 ? driftRooms / rooms : 0;
  console.log(
    JSON.stringify(
      {
        redis: redacted(URL),
        rooms,
        entries,
        transitionsChecked: entries - rooms,
        contractViolations: violations.length - driftRooms,
        driftRooms,
        driftRate,
        violations: violations.slice(0, 20),
      },
      null,
      2,
    ),
  );
  if (GATE && violations.length > 0) {
    console.error(`[replay-check] FAILED: ${violations.length} violation(s)`);
    process.exit(1);
  }
  console.log('[replay-check] PASSED');
}

void main();
