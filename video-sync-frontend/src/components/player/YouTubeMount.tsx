import React, { useEffect } from 'react';
import styled from '@emotion/styled';
import { YouTubeAdapter } from '../../sync/YouTubeAdapter';
import type { EngineAdapter } from '../../sync/SyncEngine';
import { MountProps } from './mount-props';

const PlayerDiv = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`;

const API_SRC = 'https://www.youtube.com/iframe_api';

// https://developers.google.com/youtube/iframe_api_reference#onError
const YT_ERRORS: Record<number, string> = {
  2: 'YouTube rejected the video id.',
  5: "YouTube's HTML5 player failed.",
  100: 'This video was not found (removed or private).',
  101: 'The owner disabled embedded playback for this video.',
  150: 'The owner disabled embedded playback for this video.',
};

/**
 * Mounts the YouTube IFrame player for a classified youtube source. The
 * shell remounts this component (key=videoId) when the video changes, so
 * one effect owns the full create/destroy story.
 */
export const YouTubeMount: React.FC<{ videoId: string } & MountProps> = ({
  videoId,
  onAdapter,
  onFailure,
}) => {
  useEffect(() => {
    let cancelled = false;
    let player: YTPlayer | null = null;
    let adapter: EngineAdapter | null = null;

    const initializePlayer = () => {
      if (cancelled) return;
      player = new window.YT.Player('youtube-player', {
        videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          modestbranding: 1,
          rel: 0,
          iv_load_policy: 3,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
        },
        events: {
          onReady: (event) => {
            // onReady arrives async after destroy() on fast source
            // changes; building the adapter then would leak its 20Hz
            // poll timer with no dispose left to run
            if (cancelled) return;
            player = event.target;
            adapter = new YouTubeAdapter(event.target);
            onAdapter(adapter);
          },
          onError: (event) => {
            if (cancelled) return;
            onFailure(
              YT_ERRORS[event.data] ??
                `YouTube player error ${event.data}.`,
            );
          },
        },
      });
    };

    const onApiReady = () => initializePlayer();
    if (window.YT?.Player) {
      initializePlayer();
    } else {
      // the API script is global: appending it twice re-runs it and races
      if (!document.querySelector(`script[src="${API_SRC}"]`)) {
        const tag = document.createElement('script');
        tag.src = API_SRC;
        document.head.appendChild(tag);
      }
      window.onYouTubeIframeAPIReady = onApiReady;
    }

    return () => {
      // a late API load would otherwise build an orphan player (and an
      // undisposed adapter poll timer) after this effect is gone
      cancelled = true;
      if (window.onYouTubeIframeAPIReady === onApiReady) {
        window.onYouTubeIframeAPIReady = undefined;
      }
      adapter?.dispose();
      onAdapter(null);
      player?.destroy?.();
    };
  }, [videoId, onAdapter, onFailure]);

  return <PlayerDiv id="youtube-player" />;
};
