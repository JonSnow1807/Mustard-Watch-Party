import { Html5Adapter } from './Html5Adapter';

/** Minimal stand-in for the TextTrackList the element exposes. */
const trackList = (
  specs: { mode: string; kind?: string }[],
) => {
  const tracks = specs.map(({ mode, kind = 'subtitles' }) => ({ mode, kind }));
  return Object.assign(tracks, { length: tracks.length }) as unknown as TextTrackList;
};

const subtitles = (...modes: string[]) => trackList(modes.map((mode) => ({ mode })));

const elementWith = (tracks: TextTrackList) =>
  ({ textTracks: tracks }) as unknown as HTMLMediaElement;

describe('HTML5 captions', () => {
  it('reports none when the source carries no track', () => {
    // a plain MP4 usually has nothing, and the UI hides its button on this
    const adapter = new Html5Adapter(elementWith(subtitles()));
    expect(adapter.hasCaptions()).toBe(false);
  });

  it('reports captions when the source has a track', () => {
    // hls.js renders HLS subtitle tracks onto the same element, so this
    // covers both a file with a sidecar and a stream
    const adapter = new Html5Adapter(elementWith(subtitles('disabled')));
    expect(adapter.hasCaptions()).toBe(true);
  });

  it('shows exactly one track, not all of them at once', () => {
    // several 'showing' tracks overlap their text on screen
    const tracks = subtitles('disabled', 'disabled', 'disabled');
    const adapter = new Html5Adapter(elementWith(tracks));

    adapter.setCaptionsEnabled(true);

    const modes = Array.from({ length: tracks.length }, (_, i) => tracks[i].mode);
    expect(modes).toEqual(['showing', 'disabled', 'disabled']);
  });

  it('turns every track off again', () => {
    const tracks = subtitles('showing', 'disabled');
    const adapter = new Html5Adapter(elementWith(tracks));

    adapter.setCaptionsEnabled(false);

    const modes = Array.from({ length: tracks.length }, (_, i) => tracks[i].mode);
    expect(modes).toEqual(['disabled', 'disabled']);
  });

  it('ignores chapters, metadata and descriptions', () => {
    // a file with only chapter markers is not a file with subtitles, and
    // switching one of those to 'showing' displays nothing
    const adapter = new Html5Adapter(
      elementWith(
        trackList([
          { mode: 'disabled', kind: 'chapters' },
          { mode: 'disabled', kind: 'metadata' },
          { mode: 'disabled', kind: 'descriptions' },
        ]),
      ),
    );
    expect(adapter.hasCaptions()).toBe(false);
  });

  it('shows the first real caption track, skipping a leading chapters track', () => {
    const tracks = trackList([
      { mode: 'disabled', kind: 'chapters' },
      { mode: 'disabled', kind: 'subtitles' },
    ]);
    const adapter = new Html5Adapter(elementWith(tracks));

    adapter.setCaptionsEnabled(true);

    // the chapters track is left alone; the subtitle track is shown
    expect(tracks[0].mode).toBe('disabled');
    expect(tracks[1].mode).toBe('showing');
  });

  it('does not throw on a source with no tracks at all', () => {
    const adapter = new Html5Adapter(elementWith(subtitles()));
    expect(() => adapter.setCaptionsEnabled(true)).not.toThrow();
  });
});

import { YouTubeAdapter } from './YouTubeAdapter';

const ytPlayer = (over: Record<string, unknown> = {}) =>
  ({
    getPlayerState: () => 1,
    getCurrentTime: () => 0,
    getDuration: () => 100,
    seekTo: jest.fn(),
    playVideo: jest.fn(),
    pauseVideo: jest.fn(),
    setPlaybackRate: jest.fn(),
    getPlaybackRate: () => 1,
    mute: jest.fn(),
    unMute: jest.fn(),
    setVolume: jest.fn(),
    ...over,
  }) as never;

describe('YouTube captions (undocumented API, so: defensive)', () => {
  // The constructor starts a 20Hz poll timer. Left undisposed these leak
  // across the suite and are exactly what makes jest complain that a worker
  // would not exit.
  const built: YouTubeAdapter[] = [];
  const adapterFor = (player: never) => {
    const adapter = new YouTubeAdapter(player);
    built.push(adapter);
    return adapter;
  };
  afterEach(() => {
    while (built.length) built.pop()?.dispose();
  });

  it('reports none when the player has no caption controls at all', () => {
    // an embed or API version without them must produce no button, not a
    // crash and not a button that does nothing
    const adapter = adapterFor(ytPlayer());
    expect(adapter.hasCaptions()).toBe(false);
  });

  it('reports none when the track list is empty or not a list', () => {
    expect(
      new YouTubeAdapter(
        ytPlayer({ loadModule: jest.fn(), getOption: () => [] }),
      ).hasCaptions(),
    ).toBe(false);

    expect(
      new YouTubeAdapter(
        ytPlayer({ loadModule: jest.fn(), getOption: () => undefined }),
      ).hasCaptions(),
    ).toBe(false);
  });

  it('reports captions when the player lists a track', () => {
    const adapter = new YouTubeAdapter(
      ytPlayer({
        loadModule: jest.fn(),
        getOption: () => [{ languageCode: 'en' }],
      }),
    );
    expect(adapter.hasCaptions()).toBe(true);
  });

  it('loads the captions module once, not on every render', () => {
    const loadModule = jest.fn();
    const adapter = new YouTubeAdapter(
      ytPlayer({ loadModule, getOption: () => [{ languageCode: 'en' }] }),
    );
    adapter.hasCaptions();
    adapter.hasCaptions();
    adapter.hasCaptions();
    expect(loadModule).toHaveBeenCalledTimes(1);
  });

  it('turns captions on with the listed language, and off with an empty track', () => {
    const setOption = jest.fn();
    const adapter = new YouTubeAdapter(
      ytPlayer({
        loadModule: jest.fn(),
        setOption,
        getOption: () => [{ languageCode: 'fr' }],
      }),
    );

    adapter.setCaptionsEnabled(true);
    expect(setOption).toHaveBeenLastCalledWith('captions', 'track', {
      languageCode: 'fr',
    });

    // there is no "disable" call in this API - an empty track object is it
    adapter.setCaptionsEnabled(false);
    expect(setOption).toHaveBeenLastCalledWith('captions', 'track', {});
  });

  it('swallows a player that throws rather than taking the room down', () => {
    const throwing = ytPlayer({
      loadModule: () => {
        throw new Error('no such module');
      },
      setOption: () => {
        throw new Error('nope');
      },
    });
    const adapter = adapterFor(throwing);
    expect(adapter.hasCaptions()).toBe(false);
    expect(() => adapter.setCaptionsEnabled(true)).not.toThrow();
  });
});
