import React, { useEffect, useRef } from 'react';
import styled from '@emotion/styled';
import { Html5Adapter } from '../../sync/Html5Adapter';
import { AudioTruthProbe } from '../../sync/audio-truth';
import { MountProps } from './mount-props';

const Media = styled.video`
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
`;

// https://developer.mozilla.org/docs/Web/API/MediaError/code
const MEDIA_ERRORS: Record<number, string> = {
  1: 'Loading was aborted.',
  2: 'A network error interrupted the download.',
  3: 'The video downloaded but could not be decoded.',
  4: 'The URL could not be loaded - not a playable video, or unreachable.',
};

/**
 * Only a same-origin element can be tapped by the Web Audio API - a
 * cross-origin tap is CORS-tainted and reads silence, which would make the
 * audio-truth ground truth quietly lie. So the probe runs exactly when the
 * tap can be real.
 */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/**
 * Mounts a plain HTMLMediaElement for classified file and hls sources.
 * This is the attempt half of attempt-and-fail-visibly: validation
 * admitted the URL because it MIGHT be a video; the element's error event
 * is where "it wasn't" surfaces, routed to the shell's failure card. The
 * shell remounts this component (key=url) when the video changes.
 *
 * HLS: Safari gets the manifest as a native src (canPlayType says so);
 * everywhere else hls.js drives Media Source Extensions. hls.js is a
 * dynamic import so the ~200KB library is a lazy chunk only HLS rooms
 * fetch - sync itself never needs it, since the adapter only reads the
 * media element and the element doesn't care who feeds it.
 */
export const Html5Mount: React.FC<
  { url: string; hls?: boolean } & MountProps
> = ({ url, hls = false, onAdapter, onFailure }) => {
  const mediaRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    const adapter = new Html5Adapter(el);
    onAdapter(adapter);

    let probe: AudioTruthProbe | null = null;
    if (isSameOrigin(url)) {
      probe = new AudioTruthProbe(el);
      void probe.start();
    }

    const onError = () => {
      const code = el.error?.code;
      onFailure(
        (code !== undefined && MEDIA_ERRORS[code]) ||
          'The video element reported an unknown error.',
      );
    };
    el.addEventListener('error', onError);
    // React assigns src during commit; this listener attaches in the
    // passive effect. A failure in that gap fires no further event, so
    // read the already-latched error once or the card never appears.
    if (el.error !== null) onError();

    let cancelled = false;
    let hlsInstance: { destroy(): void } | null = null;
    if (hls) {
      if (el.canPlayType('application/vnd.apple.mpegurl') !== '') {
        el.src = url; // Safari and iOS: the manifest IS a native source
      } else {
        void import('hls.js').then(({ default: Hls }) => {
          // the chunk can land after a fast source change tore us down;
          // attaching then would feed a dead element and leak the instance
          if (cancelled) return;
          if (!Hls.isSupported()) {
            onFailure(
              'This browser supports neither native HLS nor Media Source Extensions.',
            );
            return;
          }
          const h = new Hls();
          hlsInstance = h;
          // one recovery attempt per error type (the canonical hls.js
          // pattern); a second fatal of the same type fails visibly
          // instead of looping a broken stream forever
          let retriedNetwork = false;
          let retriedMedia = false;
          h.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal || cancelled) return;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && !retriedNetwork) {
              retriedNetwork = true;
              h.startLoad();
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !retriedMedia) {
              retriedMedia = true;
              h.recoverMediaError();
              return;
            }
            h.destroy();
            hlsInstance = null;
            onFailure(`HLS playback failed (${data.details}).`);
          });
          h.loadSource(url);
          h.attachMedia(el);
        });
      }
    }

    return () => {
      cancelled = true;
      el.removeEventListener('error', onError);
      hlsInstance?.destroy();
      probe?.stop();
      adapter.dispose();
      onAdapter(null);
    };
  }, [url, hls, onAdapter, onFailure]);

  return (
    <Media
      ref={mediaRef}
      src={hls ? undefined : url}
      playsInline
      data-testid="html5-video"
    />
  );
};
