// Minimal typings for the subset of the YouTube IFrame Player API this app uses.
// Reference: https://developers.google.com/youtube/iframe_api_reference

export {};

declare global {
  interface YTPlayer {
    playVideo(): void;
    pauseVideo(): void;
    seekTo(seconds: number, allowSeekAhead: boolean): void;
    getCurrentTime(): number;
    getDuration(): number;
    getPlayerState(): number;
    setPlaybackRate(suggestedRate: number): void;
    getPlaybackRate(): number;
    getAvailablePlaybackRates(): number[];
    mute(): void;
    unMute(): void;
    isMuted(): boolean;
    setVolume(volume: number): void;
    /**
     * Caption controls. NOT part of YouTube's documented IFrame API - they
     * work in practice and have for years, but nothing promises they will,
     * so every call site treats absence and failure as "no captions" rather
     * than as an error. Optional for exactly that reason.
     */
    loadModule?(module: string): void;
    unloadModule?(module: string): void;
    setOption?(module: string, option: string, value: unknown): void;
    getOption?(module: string, option: string): unknown;
    destroy(): void;
  }

  interface YTPlayerEvent {
    target: YTPlayer;
    data: number;
  }

  interface YTNamespace {
    Player: new (
      elementId: string | HTMLElement,
      config: {
        videoId?: string;
        width?: string | number;
        height?: string | number;
        playerVars?: Record<string, string | number>;
        events?: {
          onReady?: (event: YTPlayerEvent) => void;
          onStateChange?: (event: YTPlayerEvent) => void;
          onPlaybackRateChange?: (event: YTPlayerEvent) => void;
          onError?: (event: YTPlayerEvent) => void;
        };
      },
    ) => YTPlayer;
    PlayerState: {
      UNSTARTED: number;
      ENDED: number;
      PLAYING: number;
      PAUSED: number;
      BUFFERING: number;
      CUED: number;
    };
  }

  interface Window {
    YT: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}
