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

  /**
   * Whether a token is available, without spending one.
   *
   * For the case where a request must clear more than one bucket: spending
   * from the first before asking the second charges callers for requests
   * that were refused anyway.
   */
  peek(key: string, now: number): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity >= 1;
    const elapsedS = Math.max(0, (now - bucket.at) / 1000);
    const tokens = Math.min(
      this.capacity,
      bucket.tokens + elapsedS * this.refillPerSecond,
    );
    return tokens >= 1;
  }

  /** Drop callers that have been full for a while, so the map cannot grow forever. */
  sweep(now: number, idleMs = 3_600_000): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > idleMs) this.buckets.delete(key);
    }
  }
}

/**
 * Is this an address belonging to infrastructure rather than to a person?
 *
 * Private, loopback, link-local and carrier-grade-NAT ranges, in both
 * families and in the IPv4-mapped-IPv6 form Node hands back on a
 * dual-stack socket. Not a security boundary - just "a human on the
 * internet cannot be reached at this address, so it is a hop, not a
 * caller".
 */
export const isInfrastructureAddress = (raw: string): boolean => {
  const ip = raw
    .trim()
    .toLowerCase()
    .replace(/^::ffff:/, '');
  if (!ip) return true;
  if (ip === '::1' || ip === 'unknown') return true;
  if (/^(10|127)\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  // 100.64.0.0/10 - what load balancers and container networks hand out
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;
  if (/^f[cd]/.test(ip)) return true; // fc00::/7, unique-local
  // fe80::/10 - which reaches febf, not just fe80. A hop anywhere in the
  // rest of that range would have read as a caller and made a fresh bucket
  // per request, which is exactly the failure this whole helper exists to
  // stop.
  if (/^fe[89ab]/.test(ip)) return true;
  return false;
};

/**
 * The caller's address, for keying a rate limiter.
 *
 * This is the third version, and the first two were both wrong in
 * production, so the reasoning is worth writing down rather than the rule.
 *
 * Take one: the LEFTMOST x-forwarded-for entry. Wrong, and dangerously so -
 * that entry is written by whoever is calling. Twelve requests with twelve
 * invented values got twelve separate allowances.
 *
 * Take two: the LAST entry, on the theory that our proxy appends the peer it
 * saw, so a forged value is pushed leftward. Sound in a one-hop chain, and it
 * passed locally. In production it failed completely: fifteen requests from
 * one machine with no forged header at all, against a capacity of ten, were
 * all admitted. So the last entry is not the caller either - the platform
 * appends its own hop, and that hop varies per request, which makes a fresh
 * bucket every time.
 *
 * Take three does not depend on knowing how many hops there are, because
 * that is the fact I kept getting wrong and cannot verify from outside.
 * Walk the chain from the right and take the first address that could
 * belong to a person - skipping the private and CGNAT hops our own
 * infrastructure adds. A caller who forges entries only ever adds them to
 * the LEFT of the one the edge observed, so the rightmost public address is
 * still theirs. If they forge a private-looking one, it is skipped as a hop
 * and we land on their real address anyway.
 *
 * Failure mode, stated because it is a real cost: if the platform's own last
 * hop is PUBLIC rather than private, this keys everyone behind it together
 * and limits them as one caller. That is coarse and could turn a limit into
 * a denial of service for a shared edge - but it fails toward refusing, not
 * toward the unbounded row creation this exists to stop. The one-shot
 * diagnostic in the controller reports which case we are actually in.
 *
 * Take four, and the one that had the actual answer: production is behind
 * CLOUDFLARE. Render fronts services with it - the response carries
 * `server: cloudflare` and a `cf-ray`, which is how this was finally found,
 * and nothing in the code or the dashboard said so.
 *
 * That is fatal to take three, because the rightmost public address in the
 * chain is then the Cloudflare EDGE address, and which edge server handles a
 * request varies. Fifteen requests from one machine produced fifteen
 * different keys and fifteen fresh allowances. It is the exact failure mode
 * written down above as a risk - only inverted: I predicted it would key
 * everyone TOGETHER, and instead it keys one person apart.
 *
 * Cloudflare sets `cf-connecting-ip` to the address it accepted the
 * connection from, and OVERWRITES any value the caller sent. So when it is
 * present it is both the true client and unforgeable, which no position in
 * x-forwarded-for is. The chain walk stays as the fallback for deployments
 * with no Cloudflare in front.
 *
 * The assumption, stated because it is the one that would break this: all
 * traffic reaches the app through Cloudflare. Someone who could hit the
 * origin directly could forge this header - but they could forge the whole
 * chain too, so it is not a step down.
 *
 * `trustProxy` is a deployment fact, not a guess - a proxy in production,
 * none on a laptop.
 */
export const clientIpFrom = (req: Request, trustProxy: boolean): string => {
  const peer = req.socket?.remoteAddress || 'unknown';
  if (!trustProxy) return peer;

  const cloudflare = req.headers['cf-connecting-ip'];
  const fromEdge = Array.isArray(cloudflare) ? cloudflare[0] : cloudflare;
  if (fromEdge?.trim()) return fromEdge.trim();

  const forwarded = req.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const parts =
    raw
      ?.split(',')
      .map((p) => p.trim())
      .filter(Boolean) ?? [];

  for (let i = parts.length - 1; i >= 0; i--) {
    if (!isInfrastructureAddress(parts[i])) return parts[i];
  }

  // Every hop looked like infrastructure - a caller reaching us from inside
  // the network, or a chain we do not understand. The socket peer is the
  // one thing no header can move.
  return peer;
};

/**
 * Production runs behind exactly one proxy (Render); local development runs
 * behind none. Same rule configuration.ts uses to decide what is local.
 */
const LOCAL_ENVS = ['development', 'test'];

export const clientIp = (req: Request): string =>
  clientIpFrom(req, !LOCAL_ENVS.includes(process.env.NODE_ENV ?? ''));
