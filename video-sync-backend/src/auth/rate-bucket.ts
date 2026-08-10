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
 * The caller's address, honouring the proxy header Render sets.
 *
 * Only the FIRST entry of x-forwarded-for is used: the rest are appended by
 * whatever came before and are attacker-controlled, so trusting the last one
 * would let a caller reset their own bucket by sending a header.
 */
export const clientIp = (req: Request): string => {
  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(',')[0]?.trim();
  return first || req.socket?.remoteAddress || 'unknown';
};
