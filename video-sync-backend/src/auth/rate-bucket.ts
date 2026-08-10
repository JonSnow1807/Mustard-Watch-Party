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
 * The caller's address, behind exactly one trusted proxy.
 *
 * The LAST entry of x-forwarded-for, not the first, and the difference is
 * the whole point of the function.
 *
 * A proxy APPENDS the peer it actually saw. So a client that sends nothing
 * produces "<client>", and a client that sends its own header produces
 * "<whatever they invented>, <client>". The leftmost entry is therefore the
 * one under the caller's control, and keying a rate limiter on it lets
 * anyone rotate their identity with a header and never hit the limit. The
 * rightmost was written by our own proxy and is the one we can believe.
 *
 * This assumes exactly one proxy in front of us, which is what Render is. On
 * a chain of N trusted proxies the correct entry is Nth from the right, and
 * on none of them the header should be ignored entirely.
 */
export const clientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const parts =
    raw
      ?.split(',')
      .map((p) => p.trim())
      .filter(Boolean) ?? [];
  const nearest = parts[parts.length - 1];
  return nearest || req.socket?.remoteAddress || 'unknown';
};
