import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import type Redis from 'ioredis';
import { DatabaseService } from '../database/database.service';
import { REDIS_KV, REDIS_PUB, REDIS_SUB } from '../redis/redis.module';
import { subjectOf, versionOf, type TokenPayload } from './token-payload';

/** Where instances tell each other that something was revoked. */
export const REVOCATION_CHANNEL = 'mustard:revocations';

/**
 * Where the snapshot is MIRRORED for consumers that have Redis but no
 * Postgres - today that is relay-go, which verifies the same tokens against
 * the same secret but had no way to learn a token was taken out of
 * circulation (docs/AUTH.md used to call this out as unclosable because
 * "the relay has no Redis connection" - which was simply false; it executes
 * the shared Lua against the same instance).
 *
 * The mirror is a CACHE of the Postgres truth, rebuilt on every refresh. If
 * Redis flushes (the deployment uses a no-persistence tier), the mirror is
 * empty until the next refresh - the relay fails open to signature-only for
 * at most REFRESH_MS, the same staleness bound an instance that missed a
 * pub/sub message already has. Postgres remains the only durable record.
 */
export const REVOKED_JTI_KEY = 'revoked:jti';
export const REVOKED_USERVER_KEY = 'revoked:userver';

/**
 * How stale an instance's picture of revocations can get if the pub/sub
 * message never arrives - Redis down, a dropped subscription, an instance
 * that started while Redis was unreachable.
 *
 * This is the honest answer to "how long does a revoked token keep working
 * in the worst case". Thirty seconds, not twelve hours.
 */
const REFRESH_MS = 30_000;

interface RevocationEvent {
  kind: 'token' | 'user';
  jti?: string;
  userId?: string;
  version?: number;
}

/**
 * Which tokens are no longer trusted, in a form the request path can consult
 * without touching anything.
 *
 * The two checks it answers are on EVERY authenticated request and every
 * socket handshake, so neither may do IO. Both planes were built to do no
 * database lookup at all, and adding one per request to gain revocation
 * would be paying for the feature in the wrong currency.
 *
 * So: an in-memory snapshot, refreshed from Postgres. It stays small by
 * construction - it holds only the tokens revoked in the last twelve hours
 * and only the users who have ever revoked everything, which for almost
 * every deployment is nobody. Postgres is the truth, because revocation
 * that forgets on restart is not revocation. Redis, when present, only
 * carries the news so other instances hear it in milliseconds rather than
 * within REFRESH_MS.
 */
@Injectable()
export class RevocationService implements OnModuleInit {
  private readonly logger = new Logger(RevocationService.name);

  /** jti values that must be refused, whatever else the token says. */
  private revokedTokens = new Set<string>();
  /** userId -> current version. Absent means 0, which is almost everyone. */
  private userVersions = new Map<string, number>();
  /** false until the first load succeeds - see isRevoked. */
  private loaded = false;

  /**
   * Revocations recorded while a refresh was in flight.
   *
   * refresh() reads from Postgres and then REPLACES the snapshot. Anything
   * revoked between the read and the replacement would be thrown away by
   * that assignment and accepted until the next tick - which contradicts the
   * one guarantee this service makes about its own instance, that a
   * revocation takes effect here at once. So writes that land during a
   * refresh are held here and merged in at the end.
   */
  private pendingTokens = new Set<string>();
  private pendingVersions = new Map<string, number>();
  private refreshing = false;

  constructor(
    private readonly database: DatabaseService,
    @Inject(REDIS_PUB) private readonly pub: Redis | null,
    @Inject(REDIS_SUB) private readonly sub: Redis | null,
    @Inject(REDIS_KV) private readonly kv: Redis | null,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();

    if (this.sub) {
      try {
        await this.sub.subscribe(REVOCATION_CHANNEL);
        this.sub.on('message', (channel, raw) => {
          if (channel !== REVOCATION_CHANNEL) return;
          this.applyEvent(raw);
        });
      } catch (err) {
        // Not fatal: the periodic refresh is the floor under this, and it
        // does not depend on Redis at all.
        this.logger.warn(
          `revocation pub/sub unavailable, falling back to ${REFRESH_MS}ms polling: ${
            err instanceof Error ? err.message : 'unknown'
          }`,
        );
      }
    }
  }

  /**
   * Is this token refused?
   *
   * Returns a reason rather than a boolean so the caller can say something
   * true to the person holding it - "signed out" and "signed out everywhere"
   * are different events and one of them means their password may have
   * changed.
   */
  isRevoked(payload: TokenPayload): 'token' | 'user' | null {
    // Before the first load has completed we know nothing, and answering
    // "not revoked" from an empty snapshot would be a confident lie. This
    // window is the boot of a single instance, and refusing during it is
    // safer than serving a revoked token - the caller retries.
    if (!this.loaded) return 'user';

    if (payload.jti && this.revokedTokens.has(payload.jti)) return 'token';

    const sub = subjectOf(payload);
    if (sub === null) return null; // the planes reject this on their own

    const claimed = versionOf(payload);
    // A malformed version claim is not a zero. Refuse it rather than let a
    // token argue its way back to the version everyone starts at.
    if (claimed === null) return 'user';

    const current = this.userVersions.get(sub) ?? 0;
    return claimed < current ? 'user' : null;
  }

  /** Take one token out of circulation - an ordinary sign-out. */
  async revokeToken(
    jti: string,
    userId: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.database.revokedToken.upsert({
      where: { jti },
      create: { jti, userId, expiresAt },
      update: {},
    });
    this.rememberToken(jti);
    await this.mirrorToken(jti);
    await this.announce({ kind: 'token', jti });
  }

  /** Stop trusting everything this user holds - sign out everywhere. */
  async revokeAllForUser(userId: string): Promise<number> {
    const user = await this.database.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
      select: { tokenVersion: true },
    });
    this.rememberVersion(userId, user.tokenVersion);
    await this.mirrorVersion(userId, user.tokenVersion);
    await this.announce({
      kind: 'user',
      userId,
      version: user.tokenVersion,
    });
    return user.tokenVersion;
  }

  /**
   * Reload the snapshot from Postgres.
   *
   * Also the recovery path: an instance that missed a pub/sub message, or
   * never had Redis, converges here within REFRESH_MS.
   */
  @Interval(REFRESH_MS)
  refresh(): Promise<void> {
    // One at a time. The pending buffers and the `refreshing` flag are shared
    // state, so two overlapping refreshes clear each other's buffers and the
    // first to finish turns the flag off for the one still running - which
    // puts back exactly the dropped-revocation bug the buffers were added to
    // fix. A slow query and a 30s timer is all it takes to overlap.
    //
    // A caller who arrives mid-refresh JOINS the running one rather than
    // starting a second: they want a fresh snapshot, and the one in flight
    // will be that.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.reload().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private inFlight: Promise<void> | null = null;

  private async reload(): Promise<void> {
    this.refreshing = true;
    this.pendingTokens.clear();
    this.pendingVersions.clear();
    try {
      const [tokens, users] = await Promise.all([
        this.database.revokedToken.findMany({
          // Rows past their expiry cannot refuse anything a signature check
          // would have accepted, so they are dead weight in memory.
          where: { expiresAt: { gt: new Date() } },
          select: { jti: true },
        }),
        this.database.user.findMany({
          where: { tokenVersion: { gt: 0 } },
          select: { id: true, tokenVersion: true },
        }),
      ]);

      const nextTokens = new Set(tokens.map((t) => t.jti));
      const nextVersions = new Map(users.map((u) => [u.id, u.tokenVersion]));

      // Merge rather than replace, or a revocation that happened while these
      // queries were in flight is silently undone. Versions take the HIGHER
      // of the two: a stored version must never move backwards, because
      // backwards means un-revoked.
      for (const jti of this.pendingTokens) nextTokens.add(jti);
      for (const [id, version] of this.pendingVersions) {
        nextVersions.set(id, Math.max(nextVersions.get(id) ?? 0, version));
      }

      this.revokedTokens = nextTokens;
      this.userVersions = nextVersions;
      this.loaded = true;

      await this.mirrorSnapshot(nextTokens, nextVersions);
    } catch (err) {
      // Keep the previous snapshot rather than emptying it. An empty
      // snapshot trusts every revoked token; a stale one only misses
      // revocations made since it was taken.
      this.logger.warn(
        `revocation refresh failed, keeping the previous snapshot: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    } finally {
      this.refreshing = false;
      this.pendingTokens.clear();
      this.pendingVersions.clear();
    }
  }

  /**
   * Rebuild the Redis mirror to match the snapshot, atomically.
   *
   * Built under temp keys and swapped in with RENAME so a reader never sees
   * a half-written set - a relay that read mid-rebuild would briefly trust
   * revoked tokens. RENAME of a nonexistent key throws, so the empty case
   * (nothing revoked anywhere) is an explicit DEL of the live keys.
   */
  private async mirrorSnapshot(
    jtis: Set<string>,
    versions: Map<string, number>,
  ): Promise<void> {
    if (!this.kv) return;
    try {
      const multi = this.kv.multi();
      const jtiTmp = `${REVOKED_JTI_KEY}:tmp`;
      const verTmp = `${REVOKED_USERVER_KEY}:tmp`;
      multi.del(jtiTmp, verTmp);
      if (jtis.size > 0) {
        multi.sadd(jtiTmp, ...jtis);
        multi.rename(jtiTmp, REVOKED_JTI_KEY);
      } else {
        multi.del(REVOKED_JTI_KEY);
      }
      if (versions.size > 0) {
        const flat: string[] = [];
        for (const [id, v] of versions) flat.push(id, String(v));
        multi.hset(verTmp, ...flat);
        multi.rename(verTmp, REVOKED_USERVER_KEY);
      } else {
        multi.del(REVOKED_USERVER_KEY);
      }
      await multi.exec();
    } catch (err) {
      // The mirror is a cache; a failed rebuild leaves the previous one,
      // which is stale rather than wrong - the same trade as the snapshot.
      this.logger.warn(
        `revocation mirror rebuild failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /** Incremental mirror writes, so the relay hears within a round trip. */
  private async mirrorToken(jti: string): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.sadd(REVOKED_JTI_KEY, jti);
    } catch (err) {
      this.logger.warn(
        `revocation mirror sadd failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  private async mirrorVersion(userId: string, version: number): Promise<void> {
    if (!this.kv) return;
    try {
      await this.kv.hset(REVOKED_USERVER_KEY, userId, String(version));
    } catch (err) {
      this.logger.warn(
        `revocation mirror hset failed: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  /** Add to the live set, and to the pending one if a refresh could clobber it. */
  private rememberToken(jti: string): void {
    this.revokedTokens.add(jti);
    if (this.refreshing) this.pendingTokens.add(jti);
  }

  /** Same, and never downwards: a lower version is an un-revocation. */
  private rememberVersion(userId: string, version: number): void {
    const current = this.userVersions.get(userId) ?? 0;
    if (version > current) this.userVersions.set(userId, version);
    if (this.refreshing) {
      const pending = this.pendingVersions.get(userId) ?? 0;
      if (version > pending) this.pendingVersions.set(userId, version);
    }
  }

  /**
   * Delete revocations for tokens that have expired anyway.
   *
   * Without this the table grows forever with rows that can never match: a
   * token past its expiry is refused by the signature check before anything
   * here is consulted.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async sweep(now: Date = new Date()): Promise<number> {
    try {
      const { count } = await this.database.revokedToken.deleteMany({
        where: { expiresAt: { lt: now } },
      });
      if (count > 0) this.logger.log(`swept ${count} expired revocation(s)`);
      return count;
    } catch (err) {
      this.logger.warn(
        `revocation sweep failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return 0;
    }
  }

  /** Visible for the gateway, which disconnects sockets on these events. */
  onEvent(handler: (event: RevocationEvent) => void): void {
    this.handlers.push(handler);
  }

  private readonly handlers: ((event: RevocationEvent) => void)[] = [];

  private async announce(event: RevocationEvent): Promise<void> {
    // Locally first and unconditionally: this instance must act on its own
    // revocation whether or not Redis is there to tell the others.
    this.notify(event);
    if (!this.pub) return;
    try {
      await this.pub.publish(REVOCATION_CHANNEL, JSON.stringify(event));
    } catch (err) {
      this.logger.warn(
        `could not announce revocation; other instances will catch up within ${REFRESH_MS}ms: ${
          err instanceof Error ? err.message : 'unknown'
        }`,
      );
    }
  }

  private applyEvent(raw: string): void {
    let event: RevocationEvent;
    try {
      event = JSON.parse(raw) as RevocationEvent;
    } catch {
      return;
    }
    if (event.kind === 'token' && event.jti) {
      this.rememberToken(event.jti);
    } else if (
      event.kind === 'user' &&
      event.userId &&
      typeof event.version === 'number' &&
      Number.isInteger(event.version) &&
      event.version > 0
    ) {
      // A missing version is NOT a zero. Zero is the version every account
      // starts at, so falling back to it would UN-revoke the user until the
      // next refresh - the same reasoning versionOf applies to a token claim,
      // applied to a message. announce() always sets it, so only a malformed
      // or truncated message reaches this branch, and ignoring it is right.
      this.rememberVersion(event.userId, event.version);
    } else {
      return;
    }
    this.notify(event);
  }

  private notify(event: RevocationEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.warn(
          `revocation handler threw: ${err instanceof Error ? err.message : 'unknown'}`,
        );
      }
    }
  }
}
