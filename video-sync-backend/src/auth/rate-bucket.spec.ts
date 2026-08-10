import { RateBucket, clientIpFrom } from './rate-bucket';
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
