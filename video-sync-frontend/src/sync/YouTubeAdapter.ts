import { PlayerLifecycle } from '../shared/sync-core/drift-controller';
import { PlayerAdapter } from '../shared/sync-core/player-adapter';

/**
 * Wraps the YouTube IFrame player behind the shared PlayerAdapter surface.
 *
 * getCurrentTime() is quantized/steppy, so the playhead is reconstructed
 * from value-change edges sampled at 20Hz: between edges the position is
 * extrapolated at the playback rate, capped so stalls don't extrapolate
 * into fiction. The M1 baseline measured this readout's noise floor; the
 * controller's deadband respects it.
 */
/** Volume is a fraction; anything outside 0..1 is a caller bug, not a mute. */
const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

export class YouTubeAdapter implements PlayerAdapter {
  private lastRaw = 0;
  private edge: { tLocal: number; value: number } | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastCommandAt = 0;
  private rate = 1;

  constructor(private player: YTPlayer) {
    this.pollTimer = setInterval(() => {
      try {
        const raw = this.player.getCurrentTime();
        if (raw !== this.lastRaw) {
          this.edge = { tLocal: Date.now(), value: raw };
          this.lastRaw = raw;
        }
      } catch {
        // player is tearing down; dispose() follows
      }
    }, 50);
  }

  getPlayerTime(): number {
    const now = Date.now();
    if (
      this.getLifecycle() === 'playing' &&
      this.edge &&
      now - this.edge.tLocal < 800
    ) {
      return this.edge.value + ((now - this.edge.tLocal) / 1000) * this.rate;
    }
    return this.lastRaw;
  }

  getLifecycle(): PlayerLifecycle {
    try {
      switch (this.player.getPlayerState()) {
        case window.YT.PlayerState.PLAYING:
          return 'playing';
        case window.YT.PlayerState.PAUSED:
          return 'paused';
        case window.YT.PlayerState.BUFFERING:
          return 'buffering';
        case window.YT.PlayerState.ENDED:
          return 'ended';
        case window.YT.PlayerState.CUED:
          return 'cued';
        default:
          return 'unstarted';
      }
    } catch {
      return 'unstarted';
    }
  }

  /** Raw numeric YT state for telemetry (harness compatibility). */
  getRawState(): number {
    try {
      return this.player.getPlayerState();
    } catch {
      return -1;
    }
  }

  getDuration(): number {
    try {
      return this.player.getDuration();
    } catch {
      return 0;
    }
  }

  seekTo(mediaTime: number): void {
    this.lastCommandAt = Date.now();
    this.edge = null; // the old edge is meaningless across a seek
    this.player.seekTo(mediaTime, true);
  }

  play(): void {
    this.lastCommandAt = Date.now();
    this.player.playVideo();
  }

  pause(): void {
    this.lastCommandAt = Date.now();
    this.player.pauseVideo();
  }

  setRate(rate: number): number {
    this.lastCommandAt = Date.now();
    this.player.setPlaybackRate(rate);
    const applied = this.player.getPlaybackRate();
    this.rate = applied;
    return applied;
  }

  /**
   * Empirical fractional-rate probe, run while CUED/paused so it is
   * inaudible. The official API rounds unsupported rates toward 1, so the
   * expected result on most videos is false — SEEK mode is the design
   * center, RATE mode the opportunistic upgrade.
   */
  async probeFractionalRate(): Promise<boolean> {
    try {
      this.player.setPlaybackRate(1.05);
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const applied = this.player.getPlaybackRate();
        if (Math.abs(applied - 1.05) < 0.001) {
          this.player.setPlaybackRate(1);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      try {
        this.player.setPlaybackRate(1);
      } catch {
        /* teardown race */
      }
    }
  }

  /** True when a recent programmatic command explains a state transition. */
  wasRecentlyCommanded(windowMs = 1500): boolean {
    return Date.now() - this.lastCommandAt < windowMs;
  }

  dispose(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  // Local audio only - never synced. YouTube takes 0-100 and keeps mute
  // separate from volume, so a muted player restored to volume 40 is still
  // muted until unMute() runs.
  setVolume(fraction: number): void {
    this.player.setVolume(Math.round(clamp01(fraction) * 100));
  }

  setMuted(muted: boolean): void {
    if (muted) this.player.mute();
    else this.player.unMute();
  }

  /**
   * Captions, local only.
   *
   * YouTube's own CC button is hidden (the embed runs controls: 0), so this
   * drives the undocumented captions module instead. Everything here is
   * defensive on purpose: if the module is absent, or the call throws, or
   * the track list is not an array, the answer is "no captions" and the UI
   * shows no button. The alternative - a button that does nothing on the
   * source most rooms use - is worse than no button.
   */
  private captionsLoaded = false;

  hasCaptions(): boolean {
    try {
      if (!this.player.loadModule || !this.player.getOption) return false;
      if (!this.captionsLoaded) {
        this.player.loadModule('captions');
        this.captionsLoaded = true;
      }
      const list = this.player.getOption('captions', 'tracklist');
      return Array.isArray(list) && list.length > 0;
    } catch {
      return false;
    }
  }

  setCaptionsEnabled(enabled: boolean): void {
    try {
      if (!this.player.setOption) return;
      // an empty track object is how this API is turned off; there is no
      // "disable" call
      this.player.setOption(
        'captions',
        'track',
        enabled ? { languageCode: this.firstCaptionLanguage() } : {},
      );
    } catch {
      /* see hasCaptions: a refusal is not an error worth surfacing */
    }
  }

  private firstCaptionLanguage(): string {
    try {
      const list = this.player.getOption?.('captions', 'tracklist');
      if (Array.isArray(list) && list.length > 0) {
        const first = list[0] as { languageCode?: string };
        if (typeof first?.languageCode === 'string') return first.languageCode;
      }
    } catch {
      /* fall through */
    }
    return 'en';
  }
}
