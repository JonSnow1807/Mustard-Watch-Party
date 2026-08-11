import {
  RateBucket,
  clientIpFrom,
  isInfrastructureAddress,
} from './rate-bucket';
import type { Request } from 'express';

describe('RateBucket', () => {
  it('allows a burst up to capacity, then refuses', () => {
    const bucket = new RateBucket(3, 1);
    const now = 1_000_000;
    expect([1, 2, 3].map(() => bucket.take('ip', now))).toEqual([
      true,
      true,
      true,
    ]);
    expect(bucket.take('ip', now)).toBe(false);
  });

  it('refills over time rather than all at once', () => {
    const bucket = new RateBucket(2, 1); // one per second
    const t0 = 1_000_000;
    bucket.take('ip', t0);
    bucket.take('ip', t0);
    expect(bucket.take('ip', t0)).toBe(false);
    expect(bucket.take('ip', t0 + 999)).toBe(false);
    expect(bucket.take('ip', t0 + 1000)).toBe(true);
  });

  it('never refills past capacity, however long the wait', () => {
    const bucket = new RateBucket(2, 1);
    const t0 = 1_000_000;
    // a day of idling must not bank a day's worth of requests
    expect(bucket.take('ip', t0 + 86_400_000)).toBe(true);
    expect(bucket.take('ip', t0 + 86_400_000)).toBe(true);
    expect(bucket.take('ip', t0 + 86_400_000)).toBe(false);
  });

  it('keeps callers apart', () => {
    const bucket = new RateBucket(1, 0);
    const now = 1_000_000;
    expect(bucket.take('a', now)).toBe(true);
    expect(bucket.take('a', now)).toBe(false);
    // b is not punished for a's spending
    expect(bucket.take('b', now)).toBe(true);
  });

  it('forgets idle callers so the map cannot grow forever', () => {
    const bucket = new RateBucket(1, 0);
    const t0 = 1_000_000;
    bucket.take('a', t0);
    expect(bucket.take('a', t0)).toBe(false);
    bucket.sweep(t0 + 7_200_000);
    // swept, so it starts full again
    expect(bucket.take('a', t0 + 7_200_000)).toBe(true);
  });
});

describe('clientIpFrom', () => {
  const req = (headers: Record<string, unknown>, remote?: string) =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as Request;

  describe('with no proxy in front (a laptop)', () => {
    it('ignores x-forwarded-for entirely', () => {
      // with nothing appending, the whole header is whatever the caller
      // typed - trusting any part of it hands them a fresh bucket per
      // request, which is exactly what a live check caught
      expect(
        clientIpFrom(
          req({ 'x-forwarded-for': 'invented' }, '127.0.0.1'),
          false,
        ),
      ).toBe('127.0.0.1');
    });

    it('keys every forgery to the same bucket', () => {
      const a = clientIpFrom(
        req({ 'x-forwarded-for': 'a' }, '127.0.0.1'),
        false,
      );
      const b = clientIpFrom(
        req({ 'x-forwarded-for': 'b' }, '127.0.0.1'),
        false,
      );
      expect(a).toBe(b);
    });
  });

  describe('behind one proxy (Render)', () => {
    it('uses the entry the proxy wrote, not the one the caller sent', () => {
      expect(
        clientIpFrom(req({ 'x-forwarded-for': 'invented, 203.0.113.9' }), true),
      ).toBe('203.0.113.9');
    });

    it('keys every forgery to the same bucket', () => {
      const a = clientIpFrom(
        req({ 'x-forwarded-for': 'evil-1, 203.0.113.9' }),
        true,
      );
      const b = clientIpFrom(
        req({ 'x-forwarded-for': 'evil-2, 203.0.113.9' }),
        true,
      );
      expect(a).toBe(b);
      expect(a).toBe('203.0.113.9');
    });

    it('handles one entry, spacing, empties, and a repeated header', () => {
      expect(
        clientIpFrom(req({ 'x-forwarded-for': '203.0.113.9' }), true),
      ).toBe('203.0.113.9');
      expect(
        clientIpFrom(req({ 'x-forwarded-for': ' 1.1.1.1 ,  2.2.2.2 ' }), true),
      ).toBe('2.2.2.2');
      expect(
        clientIpFrom(req({ 'x-forwarded-for': '1.1.1.1, ,' }, '9.9.9.9'), true),
      ).toBe('1.1.1.1');
      expect(
        clientIpFrom(req({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }), true),
      ).toBe('2.2.2.2');
    });

    it('falls back to the socket when the header is absent', () => {
      expect(clientIpFrom(req({}, '5.6.7.8'), true)).toBe('5.6.7.8');
      expect(clientIpFrom(req({}), true)).toBe('unknown');
    });
  });
});

describe('a keyless bucket, for what a key cannot defend', () => {
  it('bounds total spend no matter what callers claim to be', () => {
    // The per-caller bucket is only as good as our ability to tell callers
    // apart, and in production that turned out not to work. A bucket with a
    // constant key cannot be escaped by anything a caller sends.
    const global = new RateBucket(3, 0);
    const claims = ['a', 'b', 'c', 'd', 'e'];
    const results = claims.map(() => global.take('all', 1_000_000));
    expect(results).toEqual([true, true, true, false, false]);
  });
});

describe('keying past a proxy chain of unknown length', () => {
  // Production disproved two earlier rules. These pin the third against the
  // shapes that broke them, so a fourth regression has to argue with a test.
  const req = (
    xff?: string | string[],
    peer = '203.0.113.9',
    cf?: string | string[],
  ) =>
    ({
      headers: {
        ...(xff === undefined ? {} : { 'x-forwarded-for': xff }),
        ...(cf === undefined ? {} : { 'cf-connecting-ip': cf }),
      },
      socket: { remoteAddress: peer },
    }) as unknown as Request;

  it('ignores a forged entry, because the caller can only prepend', () => {
    // take one shipped this as the answer, and twelve invented values
    // bought twelve separate allowances
    const a = clientIpFrom(req('1.1.1.1, 198.51.100.7'), true);
    const b = clientIpFrom(req('2.2.2.2, 198.51.100.7'), true);
    expect(a).toBe('198.51.100.7');
    expect(b).toBe(a);
  });

  it('sees past a trailing infrastructure hop - the take-two failure', () => {
    // fifteen honest requests were all admitted in production because this
    // trailing hop varies per request; keying on it made a fresh bucket
    // every time
    const a = clientIpFrom(req('198.51.100.7, 10.201.4.31'), true);
    const b = clientIpFrom(req('198.51.100.7, 10.201.99.2'), true);
    expect(a).toBe('198.51.100.7');
    expect(b).toBe(a);
  });

  it('holds however many hops the platform adds', () => {
    expect(
      clientIpFrom(
        req('9.9.9.9, 198.51.100.7, 10.0.0.1, 100.64.3.7, ::1'),
        true,
      ),
    ).toBe('198.51.100.7');
  });

  it('is not fooled by a caller forging a private-looking address', () => {
    // skipped as a hop, so we land on the address the edge actually saw
    expect(clientIpFrom(req('10.0.0.5, 198.51.100.7'), true)).toBe(
      '198.51.100.7',
    );
  });

  it('falls back to the socket peer when every hop is infrastructure', () => {
    expect(clientIpFrom(req('10.0.0.5, 127.0.0.1'), true)).toBe('203.0.113.9');
    expect(clientIpFrom(req(undefined), true)).toBe('203.0.113.9');
  });

  it('ignores the header entirely when there is no proxy to trust', () => {
    // with nothing in front of us the whole header is the caller's to write
    expect(clientIpFrom(req('1.1.1.1'), false)).toBe('203.0.113.9');
  });

  it('reads the IPv4-mapped form Node hands back on a dual-stack socket', () => {
    expect(isInfrastructureAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isInfrastructureAddress('::ffff:198.51.100.7')).toBe(false);
  });

  it('treats unique-local and link-local IPv6 as hops', () => {
    expect(isInfrastructureAddress('fd00::1')).toBe(true);
    expect(isInfrastructureAddress('2001:db8::1')).toBe(false);
  });

  it('covers link-local past fe80 - the range runs to febf', () => {
    // A hop at fe90:: read as a caller under the first version of this, and
    // a varying one would have made a fresh bucket per request: the exact
    // failure the helper exists to prevent, reintroduced by an off-by-a-
    // nibble.
    for (const ip of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1']) {
      expect(isInfrastructureAddress(ip)).toBe(true);
    }
    // fec0::/10 was site-local and is deprecated - not link-local, and not
    // ours to claim
    expect(isInfrastructureAddress('fec0::1')).toBe(false);
  });

  it('does not mistake a public 100.x address for CGNAT', () => {
    // 100.64/10 is shared address space; 100.128.x is ordinary internet
    expect(isInfrastructureAddress('100.64.0.1')).toBe(true);
    expect(isInfrastructureAddress('100.127.255.254')).toBe(true);
    expect(isInfrastructureAddress('100.128.0.1')).toBe(false);
    expect(isInfrastructureAddress('100.63.255.255')).toBe(false);
  });
});

describe('peek, for a request that has to clear two buckets', () => {
  it('reports availability without spending anything', () => {
    const bucket = new RateBucket(1, 0);
    const now = 1_000_000;
    expect(bucket.peek('a', now)).toBe(true);
    expect(bucket.peek('a', now)).toBe(true); // still there
    expect(bucket.take('a', now)).toBe(true);
    expect(bucket.peek('a', now)).toBe(false);
  });

  it('accounts for refill, so it agrees with take', () => {
    const bucket = new RateBucket(1, 1);
    const t0 = 1_000_000;
    bucket.take('a', t0);
    expect(bucket.peek('a', t0 + 500)).toBe(false);
    expect(bucket.peek('a', t0 + 1000)).toBe(true);
    expect(bucket.take('a', t0 + 1000)).toBe(true);
  });
});

describe('behind Cloudflare, which is what production actually is', () => {
  const req = (headers: Record<string, string | string[]>, peer = '10.0.0.1') =>
    ({ headers, socket: { remoteAddress: peer } }) as unknown as Request;

  it('prefers the address Cloudflare accepted the connection from', () => {
    // Take three keyed on the rightmost public entry, which behind
    // Cloudflare is the EDGE server - and which edge handles a request
    // varies, so fifteen requests from one machine bought fifteen fresh
    // allowances in production.
    const a = clientIpFrom(
      req({
        'cf-connecting-ip': '45.25.208.233',
        'x-forwarded-for': '45.25.208.233, 172.71.150.4',
      }),
      true,
    );
    const b = clientIpFrom(
      req({
        'cf-connecting-ip': '45.25.208.233',
        'x-forwarded-for': '45.25.208.233, 104.23.209.88', // a different edge
      }),
      true,
    );
    expect(a).toBe('45.25.208.233');
    expect(b).toBe(a);
  });

  it('is not moved by a forged chain, because Cloudflare overwrites its own header', () => {
    expect(
      clientIpFrom(
        req({
          'cf-connecting-ip': '45.25.208.233',
          'x-forwarded-for': '1.1.1.1, 2.2.2.2, 45.25.208.233, 172.71.150.4',
        }),
        true,
      ),
    ).toBe('45.25.208.233');
  });

  it('falls back to the chain where there is no Cloudflare in front', () => {
    // The header is absent entirely on a deployment without it, and the
    // walk still has to work - this is not a Cloudflare-only service.
    expect(
      clientIpFrom(
        req({ 'x-forwarded-for': '198.51.100.7, 10.201.4.31' }),
        true,
      ),
    ).toBe('198.51.100.7');
  });

  it('ignores an empty header rather than keying everyone to blank', () => {
    expect(
      clientIpFrom(
        req({ 'cf-connecting-ip': '  ', 'x-forwarded-for': '198.51.100.7' }),
        true,
      ),
    ).toBe('198.51.100.7');
  });

  it('still ignores it when there is no proxy to trust at all', () => {
    expect(
      clientIpFrom(
        req({ 'cf-connecting-ip': '1.1.1.1' }, '203.0.113.9'),
        false,
      ),
    ).toBe('203.0.113.9');
  });
});
