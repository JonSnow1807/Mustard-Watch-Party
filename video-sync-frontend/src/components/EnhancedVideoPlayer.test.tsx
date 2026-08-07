import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnhancedVideoPlayer } from './EnhancedVideoPlayer';

// The shell only needs the socket surface; a null socket keeps the sync
// engine dormant so these tests exercise mount selection, not sync.
jest.mock('../contexts/SocketContext', () => ({
  useSocket: () => ({ socket: null, connected: false }),
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

const renderPlayer = (videoUrl: string) =>
  render(<EnhancedVideoPlayer videoUrl={videoUrl} roomCode="TEST01" isHost />);

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

test('a Vimeo URL shows the not-yet-supported card', () => {
  renderPlayer('https://vimeo.com/76979871');
  expect(screen.getByTestId('failure-card')).toHaveTextContent(
    "Vimeo isn't supported yet",
  );
});

test('a hostile scheme never reaches a media element', () => {
  renderPlayer('javascript:alert(1)');
  expect(screen.getByTestId('failure-card')).toHaveTextContent(
    "can't be played",
  );
  expect(screen.queryByTestId('html5-video')).toBeNull();
  expect(document.getElementById('youtube-player')).toBeNull();
});
