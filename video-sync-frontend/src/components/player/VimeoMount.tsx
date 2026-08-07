import React, { useEffect, useRef } from 'react';
import styled from '@emotion/styled';
import { VimeoAdapter } from '../../sync/VimeoAdapter';
import { MountProps } from './mount-props';

// The SDK builds its iframe inside this container; the container owns the
// geometry so the embed fills the shell's 16:9 area.
const Container = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;

  & iframe {
    width: 100%;
    height: 100%;
  }
`;

/**
 * Mounts the Vimeo player for a classified vimeo source. Like hls.js, the
 * SDK is a dynamic import - a lazy chunk only Vimeo rooms fetch. The shell
 * remounts this component (key=videoId) when the video changes.
 */
export const VimeoMount: React.FC<
  { videoId: string; hash?: string } & MountProps
> = ({ videoId, hash, onAdapter, onFailure }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let sdkPlayer: { destroy(): Promise<void> } | null = null;
    let adapter: VimeoAdapter | null = null;

    void import('@vimeo/player').then(({ default: Player }) => {
      // the chunk can land after a fast source change tore us down
      if (cancelled) return;
      const player = new Player(container, {
        // the url form carries the unlisted-video hash (vimeo.com/<id>/<h>);
        // the typed `h` option lags in the SDK typings
        ...(hash !== undefined
          ? { url: `https://vimeo.com/${videoId}/${hash}` }
          : { id: Number(videoId) }),
        // the shell owns controls; videos below Vimeo's paid tiers ignore
        // this and show their own - sync still reconciles either way
        controls: false,
        // two tabs of one browser must not pause each other mid-party
        autopause: false,
        keyboard: false,
        dnt: true,
      });
      sdkPlayer = player;

      player.on('error', (e: { message?: string }) => {
        if (!cancelled) {
          onFailure(e?.message ?? 'The Vimeo player reported an error.');
        }
      });

      player
        .ready()
        .then(() => {
          if (cancelled) return;
          adapter = new VimeoAdapter(player);
          onAdapter(adapter);
        })
        .catch((e: { message?: string }) => {
          // ready() rejects for private/deleted/embed-restricted videos
          if (!cancelled) {
            onFailure(
              e?.message ?? 'Vimeo could not load this video (private or removed).',
            );
          }
        });
    });

    return () => {
      cancelled = true;
      adapter?.dispose();
      onAdapter(null);
      void sdkPlayer?.destroy().catch(() => {
        /* already gone */
      });
    };
  }, [videoId, hash, onAdapter, onFailure]);

  return <Container ref={containerRef} data-testid="vimeo-mount" />;
};
