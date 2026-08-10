import { PlayerLifecycle } from '../shared/sync-core/drift-controller';
import { PlayerAdapter } from '../shared/sync-core/player-adapter';

/**
 * The slice of the Vimeo Player SDK the adapter drives, structural so
 * tests can hand in a plain fake. Every read is a postMessage round-trip
 * returning a Promise - which is the whole reason this adapter keeps a
 * local model instead of asking the player anything on the hot path.
 */
export interface VimeoPlayerLike {
  on(event: string, callback: (data?: unknown) => void): void;
  off(event: string, callback?: (data?: unknown) => void): void;
  getDuration(): Promise<number>;
  setCurrentTime(seconds: number): Promise<number>;
  play(): Promise<void>;
  pause(): Promise<void>;
  setPlaybackRate(rate: number): Promise<number>;
  getPlaybackRate(): Promise<number>;
  /** local audio; optional because older embeds predate it */
  setVolume?(volume: number): Promise<number>;
}

interface TimePayload {
  seconds: number;
  duration?: number;
}

/**
 * Wraps the Vimeo player behind the shared PlayerAdapter surface.
 *
 * The SDK is promise-only, but the engine's contract is synchronous reads
 * on a 250ms cadence - so the playhead is modeled locally from `timeupdate`
 * edges (~4Hz while playing) and extrapolated at the playback rate between
 * them, capped so a stalled pipe reads as its last truth instead of
 * fiction. Same edge-reconstruction idea as YouTubeAdapter, different
 * transport: events push edges here, YT gets polled.
 */
/** Volume is a fraction; anything outside 0..1 is a caller bug, not a mute. */
const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;

export class VimeoAdapter implements PlayerAdapter {
  private edge: { tLocal: number; value: number } | null = null;
  private lastKnown = 0;
  private durationS = 0;
  private life: PlayerLifecycle = 'unstarted';
  private rate = 1;
  private lastCommandAt = 0;
  private handlers: Array<[string, (data?: unknown) => void]> = [];

  constructor(private player: VimeoPlayerLike) {
    const on = (event: string, callback: (data?: unknown) => void) => {
      this.handlers.push([event, callback]);
      player.on(event, callback);
    };

    on('timeupdate', (d) => {
      const p = d as TimePayload;
      this.lastKnown = p.seconds;
      this.edge = { tLocal: Date.now(), value: p.seconds };
      if (p.duration) this.durationS = p.duration;
    });
    on('seeked', (d) => {
      const p = d as TimePayload;
      this.lastKnown = p.seconds;
      this.edge = { tLocal: Date.now(), value: p.seconds };
    });
    on('play', () => {
      this.life = 'playing';
    });
    on('pause', () => {
      this.life = 'paused';
    });
    on('bufferstart', () => {
      this.life = 'buffering';
    });
    on('bufferend', () => {
      // a pause during the stall arrives as its own event after this one
      if (this.life === 'buffering') this.life = 'playing';
    });
    on('ended', () => {
      this.life = 'ended';
    });
    on('loaded', () => {
      if (this.life === 'unstarted') this.life = 'cued';
    });
    on('playbackratechange', (d) => {
      this.rate = (d as { playbackRate: number }).playbackRate;
    });
    on('durationchange', (d) => {
      this.durationS = (d as { duration: number }).duration;
    });

    void player
      .getDuration()
      .then((d) => {
        this.durationS = d;
      })
      .catch(() => {
        /* duration arrives via events once playback starts */
      });
  }

  getPlayerTime(): number {
    const now = Date.now();
    // timeupdate cadence is ~250ms while playing; past 1200ms the edge is
    // stale (stall, teardown) and extrapolating it would be fiction
    if (
      this.life === 'playing' &&
      this.edge &&
      now - this.edge.tLocal < 1200
    ) {
      return this.edge.value + ((now - this.edge.tLocal) / 1000) * this.rate;
    }
    return this.lastKnown;
  }

  getLifecycle(): PlayerLifecycle {
    return this.life;
  }

  /** Numeric state for the harness telemetry contract (1 = PLAYING). */
  getRawState(): number {
    switch (this.life) {
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
    return this.durationS;
  }

  seekTo(mediaTime: number): void {
    this.lastCommandAt = Date.now();
    this.edge = null; // the old edge is meaningless across a seek
    void this.player.setCurrentTime(Math.max(0, mediaTime)).catch(() => {
      /* teardown race */
    });
  }

  play(): void {
    this.lastCommandAt = Date.now();
    void this.player.play().catch(() => {
      /* autoplay policy: the engine surfaces the gesture chip */
    });
  }

  pause(): void {
    this.lastCommandAt = Date.now();
    void this.player.pause().catch(() => {
      /* teardown race */
    });
  }

  /**
   * The SDK apply is async but the engine needs the effective rate NOW.
   * probeFractionalRate gates RATE mode on rate control actually working,
   * so reporting the requested rate optimistically is honest; if the apply
   * still rejects (owner revoked it mid-session), the model falls back to
   * 1 and the next playbackratechange event is the truth.
   */
  setRate(rate: number): number {
    this.lastCommandAt = Date.now();
    this.rate = rate;
    void this.player.setPlaybackRate(rate).catch(() => {
      this.rate = 1;
    });
    return rate;
  }

  /**
   * Vimeo honours fractional rates only when the video's owner left rate
   * control enabled - setPlaybackRate rejects otherwise, which lands the
   * engine in SEEK mode, the design center.
   */
  async probeFractionalRate(): Promise<boolean> {
    try {
      await this.player.setPlaybackRate(1.05);
      const applied = await this.player.getPlaybackRate();
      return Math.abs(applied - 1.05) < 0.001;
    } catch {
      return false;
    } finally {
      try {
        await this.player.setPlaybackRate(1);
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
    for (const [event, callback] of this.handlers) {
      this.player.off(event, callback);
    }
    this.handlers = [];
  }

  // Local audio only - never synced. Vimeo has no mute call: muting is
  // volume 0, so the caller keeps the pre-mute level to restore.
  setVolume(fraction: number): void {
    void this.player.setVolume?.(clamp01(fraction));
  }

  setMuted(muted: boolean): void {
    void this.player.setVolume?.(muted ? 0 : 1);
  }
}
