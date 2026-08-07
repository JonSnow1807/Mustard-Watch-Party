import { VimeoAdapter, VimeoPlayerLike } from './VimeoAdapter';

/** Minimal event-emitting fake of the SDK surface the adapter drives. */
class FakePlayer implements VimeoPlayerLike {
  listeners = new Map<string, Array<(data?: unknown) => void>>();
  rateControlEnabled = true;
  appliedRate = 1;
  setCurrentTime = jest.fn(() => Promise.resolve(0));
  play = jest.fn(() => Promise.resolve());
  pause = jest.fn(() => Promise.resolve());

  on(event: string, callback: (data?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(callback);
    this.listeners.set(event, list);
  }

  off(event: string, callback?: (data?: unknown) => void): void {
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      callback ? list.filter((cb) => cb !== callback) : [],
    );
  }

  emit(event: string, data?: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(data);
  }

  getDuration(): Promise<number> {
    return Promise.resolve(636);
  }

  setPlaybackRate(rate: number): Promise<number> {
    if (!this.rateControlEnabled) {
      return Promise.reject(new Error('rate control disabled by owner'));
    }
    this.appliedRate = rate;
    return Promise.resolve(rate);
  }

  getPlaybackRate(): Promise<number> {
    return Promise.resolve(this.appliedRate);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('lifecycle follows SDK events', () => {
  const p = new FakePlayer();
  const a = new VimeoAdapter(p);
  expect(a.getLifecycle()).toBe('unstarted');
  p.emit('loaded');
  expect(a.getLifecycle()).toBe('cued');
  p.emit('play');
  expect(a.getLifecycle()).toBe('playing');
  p.emit('bufferstart');
  expect(a.getLifecycle()).toBe('buffering');
  p.emit('bufferend');
  expect(a.getLifecycle()).toBe('playing');
  p.emit('pause');
  expect(a.getLifecycle()).toBe('paused');
  p.emit('ended');
  expect(a.getLifecycle()).toBe('ended');
});

test('playhead comes from timeupdate edges; paused reads stay put', () => {
  const p = new FakePlayer();
  const a = new VimeoAdapter(p);
  p.emit('timeupdate', { seconds: 42.5, duration: 636 });
  // paused: no extrapolation, the edge value is the truth
  expect(a.getPlayerTime()).toBe(42.5);
  expect(a.getDuration()).toBe(636);

  // playing: extrapolates forward from the edge, never backwards
  p.emit('play');
  expect(a.getPlayerTime()).toBeGreaterThanOrEqual(42.5);
});

test('a seek invalidates the edge and commands the player', () => {
  const p = new FakePlayer();
  const a = new VimeoAdapter(p);
  p.emit('play');
  p.emit('timeupdate', { seconds: 100 });
  a.seekTo(30);
  expect(p.setCurrentTime).toHaveBeenCalledWith(30);
  // between the command and the seeked event the model holds the last
  // known value rather than extrapolating a dead edge
  expect(a.getPlayerTime()).toBe(100);
  p.emit('seeked', { seconds: 30 });
  expect(a.getPlayerTime()).toBeGreaterThanOrEqual(30);
});

test('probeFractionalRate: true when the owner allows rate control', async () => {
  const p = new FakePlayer();
  const a = new VimeoAdapter(p);
  await expect(a.probeFractionalRate()).resolves.toBe(true);
  // the probe must leave the player at 1x
  expect(p.appliedRate).toBe(1);
});

test('probeFractionalRate: false when setPlaybackRate rejects (SEEK mode)', async () => {
  const p = new FakePlayer();
  p.rateControlEnabled = false;
  const a = new VimeoAdapter(p);
  await expect(a.probeFractionalRate()).resolves.toBe(false);
});

test('setRate is optimistic and falls back to 1 on rejection', async () => {
  const p = new FakePlayer();
  p.rateControlEnabled = false;
  const a = new VimeoAdapter(p);
  p.emit('play');
  p.emit('timeupdate', { seconds: 10 });
  expect(a.setRate(1.05)).toBe(1.05);
  await tick(); // the rejected apply lands
  // extrapolation now runs at the fallback rate, not the refused one
  const t1 = a.getPlayerTime();
  expect(t1).toBeGreaterThanOrEqual(10);
});

test('dispose unsubscribes every handler', () => {
  const p = new FakePlayer();
  const a = new VimeoAdapter(p);
  a.dispose();
  p.listeners.forEach((list) => expect(list).toHaveLength(0));
  // events after dispose must not mutate the model
  p.emit('play');
  expect(a.getLifecycle()).toBe('unstarted');
});
