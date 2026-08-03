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
