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
 * Mounts a plain HTMLMediaElement for classified file (and, until hls.js
 * lands, hls) sources. This is the attempt half of attempt-and-fail-visibly:
 * validation admitted the URL because it MIGHT be a video; the element's
 * error event is where "it wasn't" surfaces, routed to the shell's failure
 * card. The shell remounts this component (key=url) when the video changes.
 */
export const Html5Mount: React.FC<{ url: string } & MountProps> = ({
  url,
  onAdapter,
  onFailure,
}) => {
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

    return () => {
      el.removeEventListener('error', onError);
      probe?.stop();
      adapter.dispose();
      onAdapter(null);
    };
  }, [url, onAdapter, onFailure]);

  return <Media ref={mediaRef} src={url} playsInline data-testid="html5-video" />;
};
