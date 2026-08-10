import { RateBucket, clientIp } from './rate-bucket';
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

describe('clientIp', () => {
  const req = (headers: Record<string, unknown>, remote?: string) =>
    ({ headers, socket: { remoteAddress: remote } }) as unknown as Request;

  it('uses the LAST x-forwarded-for entry - the one our proxy wrote', () => {
    // A proxy APPENDS the peer it saw, so a caller who sends their own
    // header produces "<invented>, <real>". Keying on the leftmost entry
    // lets anyone rotate identity with a header and never hit the limit.
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe(
      '10.0.0.1',
    );
  });

  it('is not fooled by a caller who forges the header', () => {
    // this is the attack the previous version was open to
    const forged = clientIp(req({ 'x-forwarded-for': 'evil-1, 203.0.113.9' }));
    const forgedAgain = clientIp(
      req({ 'x-forwarded-for': 'evil-2, 203.0.113.9' }),
    );
    // whatever they invent, they key to the same bucket
    expect(forged).toBe(forgedAgain);
    expect(forged).toBe('203.0.113.9');
  });

  it('handles a single entry, spacing, and empty segments', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }))).toBe(
      '203.0.113.9',
    );
    expect(clientIp(req({ 'x-forwarded-for': ' 1.1.1.1 ,  2.2.2.2 ' }))).toBe(
      '2.2.2.2',
    );
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, ,' }, '9.9.9.9'))).toBe(
      '1.1.1.1',
    );
  });

  it('falls back to the socket, then to a constant', () => {
    expect(clientIp(req({}, '5.6.7.8'))).toBe('5.6.7.8');
    expect(clientIp(req({}))).toBe('unknown');
  });

  it('handles the header arriving as an array', () => {
    // node gives an array when the header appears more than once; the
    // nearest proxy is still the last thing written
    expect(clientIp(req({ 'x-forwarded-for': ['9.9.9.9, 10.0.0.1'] }))).toBe(
      '10.0.0.1',
    );
    expect(clientIp(req({ 'x-forwarded-for': ['1.1.1.1', '2.2.2.2'] }))).toBe(
      '2.2.2.2',
    );
  });
});
