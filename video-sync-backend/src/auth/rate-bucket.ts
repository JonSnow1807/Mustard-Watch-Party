import type { Request } from 'express';

/**
 * A token bucket keyed by caller, for REST routes that create something
 * without asking who you are.
 *
 * Deliberately the same shape as the one in timeline.service.ts rather than a
 * new dependency: it is twenty lines, the behaviour is already understood
 * here, and a rate limiter that nobody can reason about is worse than none.
 *
 * In-memory and per-instance, so the effective allowance multiplies by the
 * number of instances behind the load balancer. That is fine for what this
 * defends - it turns "fill the users table from a shell loop" into "fill it
 * slowly from many addresses", which is the shape of abuse a bucket can
 * address at all. Anything stronger belongs at the edge.
 */
export class RateBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {}

  /** True if the caller may proceed, spending one token. */
  take(key: string, now: number): boolean {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, at: now };
    const elapsedS = Math.max(0, (now - bucket.at) / 1000);
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedS * this.refillPerSecond,
    );
    bucket.at = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }

  /** Drop callers that have been full for a while, so the map cannot grow forever. */
  sweep(now: number, idleMs = 3_600_000): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > idleMs) this.buckets.delete(key);
    }
  }
}

/**
 * The caller's address, for keying a rate limiter.
 *
 * x-forwarded-for is only consulted when we are actually behind a proxy,
 * because otherwise the entire header is written by the caller. My first
 * attempt at this took the last entry on the theory that a proxy appends
 * the peer it saw - true, but only if a proxy is there. With no proxy the
 * header has exactly one entry and that entry is whatever the caller typed,
 * so twelve requests with twelve invented values got twelve separate
 * allowances. A live check caught it; the reasoning had looked airtight.
 *
 * So: behind a proxy, the LAST entry, which is the one our own proxy wrote
 * (a caller who sends their own produces "<invented>, <real>", making the
 * leftmost theirs and the rightmost ours). Otherwise the socket peer, which
 * no header can influence.
 *
 * `trustProxy` is a deployment fact, not a guess - one hop on Render, none
 * on a laptop.
 */
export const clientIpFrom = (req: Request, trustProxy: boolean): string => {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (!trustProxy) return peer;

  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const parts =
    raw
      ?.split(',')
      .map((p) => p.trim())
      .filter(Boolean) ?? [];
  return parts[parts.length - 1] || peer;
};

/**
 * Production runs behind exactly one proxy (Render); local development runs
 * behind none. Same rule configuration.ts uses to decide what is local.
 */
const LOCAL_ENVS = ['development', 'test'];

export const clientIp = (req: Request): string =>
  clientIpFrom(req, !LOCAL_ENVS.includes(process.env.NODE_ENV ?? ''));
