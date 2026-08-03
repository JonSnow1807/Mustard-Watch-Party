import { PlayerLifecycle } from './drift-controller';

/**
 * The surface the sync engine drives. Implemented by the frontend's
 * YouTubeAdapter (real IFrame player) and the harness's SimPlayer (bots) —
 * one controller, three consumers (browser, bots, jest).
 */
export interface PlayerAdapter {
  /** de-quantized playhead in seconds (edge-reconstructed where needed) */
  getPlayerTime(): number;
  getLifecycle(): PlayerLifecycle;
  seekTo(mediaTime: number): void;
  play(): void;
  pause(): void;
  /**
   * Attempt a playback-rate change; returns the rate actually in effect
   * afterwards (the YouTube player rounds unsupported values toward 1).
   */
  setRate(rate: number): number;
}
