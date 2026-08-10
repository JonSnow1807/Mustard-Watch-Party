import { PlayerLifecycle } from '../shared/sync-core/drift-controller';
import { PlayerAdapter } from '../shared/sync-core/player-adapter';

/**
 * PlayerAdapter over a plain HTMLMediaElement.
 *
 * Two reasons this exists beyond the audio experiment:
 *  - it demonstrates the sync core is player-agnostic (the same estimator and
 *    controller drive YouTube and a <video> tag with no changes), and
 *  - a same-origin element can be tapped by the Web Audio API, which a
 *    cross-origin YouTube iframe cannot - that tap is what gives M10 a
 *    ground truth independent of any player's own clock.
 *
 * `currentTime` here is a genuine float (no postMessage quantization), so no
 * edge reconstruction is needed - which is itself a useful contrast when
 * reading the YouTube readout-noise histogram.
 */
/** Volume is a fraction; anything outside 0..1 is a caller bug, not a mute. */
const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

export class Html5Adapter implements PlayerAdapter {
  private lastCommandAt = 0;

  constructor(private el: HTMLMediaElement) {}

  getPlayerTime(): number {
    return this.el.currentTime;
  }

  getLifecycle(): PlayerLifecycle {
    if (this.el.ended) return 'ended';
    if (this.el.readyState < 3) return 'buffering';
    if (this.el.seeking) return 'buffering';
    if (this.el.paused) return this.el.currentTime > 0 ? 'paused' : 'cued';
    return 'playing';
  }

  /** Numeric state for the harness telemetry contract (1 = PLAYING). */
  getRawState(): number {
    switch (this.getLifecycle()) {
      case 'playing':
        return 1;
      case 'paused':
        return 2;
      case 'buffering':
        return 3;
      case 'ended':
        return 0;
      case 'cued':
        return 5;
      default:
        return -1;
    }
  }

  getDuration(): number {
    return Number.isFinite(this.el.duration) ? this.el.duration : 0;
  }

  seekTo(mediaTime: number): void {
    this.lastCommandAt = Date.now();
    this.el.currentTime = Math.max(0, mediaTime);
  }

  play(): void {
    this.lastCommandAt = Date.now();
    void this.el.play().catch(() => {
      /* autoplay policy: the engine surfaces the gesture chip */
    });
  }

  pause(): void {
    this.lastCommandAt = Date.now();
    this.el.pause();
  }

  setRate(rate: number): number {
    this.lastCommandAt = Date.now();
    this.el.playbackRate = rate;
    return this.el.playbackRate;
  }

  /** HTMLMediaElement honours arbitrary rates, so the probe always passes. */
  probeFractionalRate(): Promise<boolean> {
    const original = this.el.playbackRate;
    this.el.playbackRate = 1.05;
    const ok = Math.abs(this.el.playbackRate - 1.05) < 1e-6;
    this.el.playbackRate = original;
    return Promise.resolve(ok);
  }

  wasRecentlyCommanded(windowMs = 1500): boolean {
    return Date.now() - this.lastCommandAt < windowMs;
  }

  dispose(): void {
    /* nothing to tear down: the element is owned by the component */
  }

  // Local audio only - never synced.
  setVolume(fraction: number): void {
    this.el.volume = clamp01(fraction);
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted;
  }
}
