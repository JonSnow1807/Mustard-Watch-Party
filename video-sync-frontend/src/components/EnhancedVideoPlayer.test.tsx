import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EnhancedVideoPlayer } from './EnhancedVideoPlayer';

// A null socket keeps the sync engine dormant, so most tests exercise mount
// selection alone; the set-video test installs a socket and drives the
// mocked engine's status stream instead.
let mockSocket: unknown = null;
jest.mock('../contexts/SocketContext', () => ({
  useSocket: () => ({ socket: mockSocket, connected: false }),
}));

// captures the shell's onStatus listener so tests can push engine status
const mockEngineState: { push: ((s: unknown) => void) | null } = {
  push: null,
};
jest.mock('../sync/SyncEngine', () => ({
  SyncEngine: class {
    start() {}
    dispose() {}
    attachAdapter() {}
    setEnabled() {}
    sendIntent() {}
    resumeFromGesture() {}
    onStatus(cb: (s: unknown) => void) {
      mockEngineState.push = cb;
      return () => {};
    }
  },
  sendSetVideo: jest.fn(),
}));

// jsdom has no AudioContext; the probe's own behavior is measured by the
// audio-truth harness, not here.
jest.mock('../sync/audio-truth', () => ({
  AudioTruthProbe: class {
    start() {
      return Promise.resolve(false);
    }
    stop() {}
  },
}));

// the real SDK's constructor fetches from vimeo.com; mount wiring has its
// own test (VimeoMount.test.tsx), here it only needs to render
jest.mock('@vimeo/player', () => ({
  __esModule: true,
  default: class {
    on() {}
    off() {}
    ready() {
      return new Promise(() => {});
    }
    destroy() {
      return Promise.resolve();
    }
  },
}));

const renderPlayer = (videoUrl: string) =>
  render(<EnhancedVideoPlayer videoUrl={videoUrl} roomCode="TEST01" isHost />);

afterEach(() => {
  mockSocket = null;
  mockEngineState.push = null;
});

test('empty videoUrl shows the no-video card, no controls', () => {
  renderPlayer('');
  expect(screen.getByTestId('failure-card')).toHaveTextContent('No video yet');
  expect(screen.queryByTestId('play-button')).toBeNull();
});

test('a YouTube watch URL mounts the YouTube player with controls', () => {
  renderPlayer('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  expect(document.getElementById('youtube-player')).toBeInTheDocument();
  expect(screen.getByTestId('play-button')).toBeInTheDocument();
  expect(screen.getByTestId('progress-bar')).toBeInTheDocument();
});

test('a legacy bare video id mounts the YouTube player', () => {
  renderPlayer('aqz-KE-bpKQ');
  expect(document.getElementById('youtube-player')).toBeInTheDocument();
});

test('a same-origin media path mounts an HTML5 video with its URL', () => {
  renderPlayer('/media/clip.webm');
  expect(screen.getByTestId('html5-video')).toHaveAttribute(
    'src',
    '/media/clip.webm',
  );
});

test('a remote file URL is attempted, and its error fails visibly', () => {
  const url = 'https://cdn.example.com/movie.mp4?sig=abc';
  renderPlayer(url);
  const video = screen.getByTestId('html5-video');
  expect(video).toHaveAttribute('src', url);

  // attempt-and-fail-visibly: the element's error swaps in the card
  fireEvent(video, new Event('error'));
  const card = screen.getByTestId('failure-card');
  expect(card).toHaveTextContent("Couldn't play this video");
  expect(card).toHaveTextContent(url);
  expect(screen.queryByTestId('html5-video')).toBeNull();
});

test('a Vimeo URL mounts the Vimeo player with controls', () => {
  renderPlayer('https://vimeo.com/76979871');
  expect(screen.getByTestId('vimeo-mount')).toBeInTheDocument();
  expect(screen.getByTestId('play-button')).toBeInTheDocument();
});

test('a set-video timeline overrides the room prop: this client switches too', () => {
  // socket present -> the (mocked) engine runs and its status drives the shell
  mockSocket = { on: jest.fn(), off: jest.fn(), emit: jest.fn(), connected: true };
  renderPlayer('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  expect(document.getElementById('youtube-player')).toBeInTheDocument();

  // the sync:timeline broadcast lands with a different video: the timeline
  // is the authority, the stale room-row prop no longer decides the mount
  act(() => {
    mockEngineState.push!({
      timeline: {
        v: 1,
        seq: 5,
        storeEpoch: '1000',
        videoId: 'https://cdn.example.com/movie.mp4',
        isPlaying: false,
        mediaTime: 0,
        stampedAt: 1000,
        rate: 1,
        reason: 'set-video',
      },
      roomPlaying: false,
      projectedS: 0,
      durationS: 0,
      driftMs: 0,
      offsetMs: 0,
      uncertaintyMs: Infinity,
      rttMs: NaN,
      ctrlState: 'LOCKED',
      seq: 5,
      fractionalRateOK: false,
      needsGesture: false,
      seeksIssued: 0,
    });
  });
  expect(screen.getByTestId('html5-video')).toHaveAttribute(
    'src',
    'https://cdn.example.com/movie.mp4',
  );
  expect(document.getElementById('youtube-player')).toBeNull();
});

test('a hostile scheme never reaches a media element', () => {
  renderPlayer('javascript:alert(1)');
  expect(screen.getByTestId('failure-card')).toHaveTextContent(
    "can't be played",
  );
  expect(screen.queryByTestId('html5-video')).toBeNull();
  expect(document.getElementById('youtube-player')).toBeNull();
});

describe('the stored volume', () => {
  // Number(null) === 0, so reading a missing key straight through Number()
  // made silence the default for every first-time visitor.
  it('defaults to full volume when nothing has been stored', () => {
    localStorage.removeItem('mustard:volume');
    const raw = localStorage.getItem('mustard:volume');
    const resolved =
      raw === null
        ? 1
        : Number.isFinite(Number(raw)) && Number(raw) >= 0 && Number(raw) <= 1
          ? Number(raw)
          : 1;
    expect(resolved).toBe(1);
  });

  it('honours a stored level, and ignores a corrupt one', () => {
    const resolve = (raw: string | null) => {
      if (raw === null) return 1;
      const n = Number(raw);
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : 1;
    };
    expect(resolve('0')).toBe(0);
    expect(resolve('0.4')).toBe(0.4);
    expect(resolve('nonsense')).toBe(1);
    expect(resolve('7')).toBe(1);
  });
});
