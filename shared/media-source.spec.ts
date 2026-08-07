import {
  MediaSource,
  VIDEO_URL_MAX_LEN,
  classifyMediaSource,
  isAcceptableVideoUrl,
} from './media-source';

describe('classifyMediaSource', () => {
  const cases: Array<[string, string | null | undefined, MediaSource]> = [
    // -- null sentinel --------------------------------------------------
    ['empty string', '', { kind: 'none', reason: 'empty' }],
    ['whitespace only', '   ', { kind: 'none', reason: 'empty' }],
    ['null', null, { kind: 'none', reason: 'empty' }],
    ['undefined', undefined, { kind: 'none', reason: 'empty' }],

    // -- YouTube --------------------------------------------------------
    [
      'bare 11-char id (legacy rooms)',
      'aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'watch URL',
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'watch URL with playlist params',
      'https://www.youtube.com/watch?v=aqz-KE-bpKQ&list=PLxyz&index=2',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'youtu.be with timestamp',
      'https://youtu.be/aqz-KE-bpKQ?t=30',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'embed URL',
      'https://www.youtube.com/embed/aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'shorts URL',
      'https://www.youtube.com/shorts/aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'live URL',
      'https://www.youtube.com/live/aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'mobile host',
      'https://m.youtube.com/watch?v=aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    [
      'nocookie host',
      'https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ',
      { kind: 'youtube', videoId: 'aqz-KE-bpKQ' },
    ],
    // a YouTube host without a valid id is a doomed fetch, not a file URL
    [
      'watch URL with malformed id',
      'https://www.youtube.com/watch?v=tooshort',
      { kind: 'none', reason: 'unsupported' },
    ],
    [
      'YouTube homepage',
      'https://www.youtube.com/',
      { kind: 'none', reason: 'unsupported' },
    ],
    [
      'playlist pseudo-id videoseries',
      'https://www.youtube.com/embed/videoseries?list=PLxyz',
      { kind: 'none', reason: 'unsupported' },
    ],

    // -- Vimeo ----------------------------------------------------------
    [
      'vimeo canonical',
      'https://vimeo.com/76979871',
      { kind: 'vimeo', videoId: '76979871' },
    ],
    [
      'vimeo unlisted hash',
      'https://vimeo.com/76979871/9b1d4c2f8a',
      { kind: 'vimeo', videoId: '76979871', hash: '9b1d4c2f8a' },
    ],
    [
      'player.vimeo.com with h param',
      'https://player.vimeo.com/video/76979871?h=9b1d4c2f8a',
      { kind: 'vimeo', videoId: '76979871', hash: '9b1d4c2f8a' },
    ],
    [
      'vimeo non-video page',
      'https://vimeo.com/about',
      { kind: 'none', reason: 'unsupported' },
    ],

    // -- HLS ------------------------------------------------------------
    [
      'm3u8',
      'https://cdn.example.com/vod/master.m3u8',
      { kind: 'hls', url: 'https://cdn.example.com/vod/master.m3u8' },
    ],
    [
      'uppercase .M3U8 with query',
      'https://cdn.example.com/vod/master.M3U8?sig=abc',
      { kind: 'hls', url: 'https://cdn.example.com/vod/master.M3U8?sig=abc' },
    ],
    [
      'movie.mp4.m3u8 is hls (last extension wins)',
      'https://cdn.example.com/movie.mp4.m3u8',
      { kind: 'hls', url: 'https://cdn.example.com/movie.mp4.m3u8' },
    ],

    // -- direct files ---------------------------------------------------
    [
      'signed mp4 (query never interferes with extension)',
      'https://cdn.example.com/movie.mp4?X-Amz-Signature=abc123',
      {
        kind: 'file',
        url: 'https://cdn.example.com/movie.mp4?X-Amz-Signature=abc123',
        container: 'mp4',
      },
    ],
    [
      'same-origin /media webm',
      '/media/clip.webm',
      { kind: 'file', url: '/media/clip.webm', container: 'webm' },
    ],
    [
      'relative media ogg',
      'media/clip.ogg',
      { kind: 'file', url: 'media/clip.ogg', container: 'ogg' },
    ],

    // -- attempt-and-fail-visibly fallback ------------------------------
    [
      'extensionless signed CDN URL',
      'https://cdn.example.com/stream/8f3ab21?token=eyJhbGciOiJI',
      {
        kind: 'file',
        url: 'https://cdn.example.com/stream/8f3ab21?token=eyJhbGciOiJI',
        container: 'unknown',
      },
    ],
    [
      'garbage text',
      'watch this movie',
      { kind: 'file', url: 'watch this movie', container: 'unknown' },
    ],

    // -- refused: could not possibly be fetched by a media element ------
    ['unparseable URL', 'http://[bad', { kind: 'none', reason: 'unsupported' }],
    [
      'javascript scheme',
      'javascript:alert(1)',
      { kind: 'none', reason: 'unsupported' },
    ],
    [
      'javascript scheme hiding behind a media extension',
      'javascript:x.mp4',
      { kind: 'none', reason: 'unsupported' },
    ],
    [
      'data scheme',
      'data:text/html,<script>alert(1)</script>',
      { kind: 'none', reason: 'unsupported' },
    ],
    [
      'blob scheme',
      'blob:https://example.com/2f9a1c3e',
      { kind: 'none', reason: 'unsupported' },
    ],
  ];

  it.each(cases)('%s', (_name, input, want) => {
    expect(classifyMediaSource(input)).toEqual(want);
  });

  it('11 chars of the id charset classify as youtube even when unintended', () => {
    // "not-a-video" is exactly 11 chars of [A-Za-z0-9_-]: the legacy-room
    // rule admits it by design; the YT player's onError owns the failure
    expect(classifyMediaSource('not-a-video')).toEqual({
      kind: 'youtube',
      videoId: 'not-a-video',
    });
  });
});

describe('isAcceptableVideoUrl', () => {
  it('admits absolute http(s) URLs, /media/ paths, and bare YouTube ids', () => {
    expect(
      isAcceptableVideoUrl('https://www.youtube.com/watch?v=aqz-KE-bpKQ'),
    ).toBe(true);
    expect(isAcceptableVideoUrl('http://cdn.example.com/movie.mp4')).toBe(true);
    expect(isAcceptableVideoUrl('/media/clip.webm')).toBe(true);
    expect(isAcceptableVideoUrl('media/clip.webm')).toBe(true);
    expect(isAcceptableVideoUrl('aqz-KE-bpKQ')).toBe(true);
  });

  it('admits extensionless signed links (playability is the player card, not validation)', () => {
    expect(
      isAcceptableVideoUrl('https://cdn.example.com/stream/8f3ab21?token=abc'),
    ).toBe(true);
    expect(isAcceptableVideoUrl('https://example.com/not-a-video-page')).toBe(
      true,
    );
  });

  it('refuses single-token garbage at the shape floor', () => {
    expect(isAcceptableVideoUrl('hello')).toBe(false);
    expect(isAcceptableVideoUrl('watch this movie')).toBe(false);
    expect(isAcceptableVideoUrl('javascript:alert(1)')).toBe(false);
    expect(isAcceptableVideoUrl('ftp://example.com/movie.mp4')).toBe(false);
  });

  it('refuses empty, oversized, and whitespace-containing inputs', () => {
    expect(isAcceptableVideoUrl('')).toBe(false);
    expect(
      isAcceptableVideoUrl('https://a.com/' + 'x'.repeat(VIDEO_URL_MAX_LEN)),
    ).toBe(false);
    expect(isAcceptableVideoUrl('https://a.com/a b')).toBe(false);
    expect(isAcceptableVideoUrl(' https://a.com/x.mp4')).toBe(false);
  });

  it('refuses provider hosts without an extractable id despite passing the shape floor', () => {
    expect(isAcceptableVideoUrl('https://www.youtube.com/')).toBe(false);
    expect(isAcceptableVideoUrl('https://vimeo.com/about')).toBe(false);
  });

  it('admits URLs at exactly the length cap', () => {
    const prefix = 'https://a.com/';
    const url = prefix + 'x'.repeat(VIDEO_URL_MAX_LEN - prefix.length);
    expect(url.length).toBe(VIDEO_URL_MAX_LEN);
    expect(isAcceptableVideoUrl(url)).toBe(true);
  });
});
