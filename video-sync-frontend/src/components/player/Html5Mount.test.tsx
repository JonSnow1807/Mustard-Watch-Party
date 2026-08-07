import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { Html5Mount } from './Html5Mount';

jest.mock('../../sync/audio-truth', () => ({
  AudioTruthProbe: class {
    start() {
      return Promise.resolve(false);
    }
    stop() {}
  },
}));

// Captures every constructed instance so tests can assert attach/teardown.
const mockHlsState: {
  supported: boolean;
  instances: Array<{
    loadSource: jest.Mock;
    attachMedia: jest.Mock;
    destroy: jest.Mock;
  }>;
} = { supported: true, instances: [] };

jest.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => mockHlsState.supported;
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
    loadSource = jest.fn();
    attachMedia = jest.fn();
    on = jest.fn();
    startLoad = jest.fn();
    recoverMediaError = jest.fn();
    destroy = jest.fn();
    constructor() {
      mockHlsState.instances.push(this);
    }
  }
  return { __esModule: true, default: FakeHls };
});

const MANIFEST = 'https://cdn.example.com/vod/master.m3u8';

beforeEach(() => {
  mockHlsState.supported = true;
  mockHlsState.instances.length = 0;
  jest.restoreAllMocks();
});

test('a file source sets src directly and never touches hls.js', () => {
  const { getByTestId } = render(
    <Html5Mount
      url="https://cdn.example.com/movie.mp4"
      onAdapter={jest.fn()}
      onFailure={jest.fn()}
    />,
  );
  expect(getByTestId('html5-video')).toHaveAttribute(
    'src',
    'https://cdn.example.com/movie.mp4',
  );
  expect(mockHlsState.instances).toHaveLength(0);
});

test('an hls source drives Media Source Extensions via hls.js', async () => {
  const { getByTestId, unmount } = render(
    <Html5Mount url={MANIFEST} hls onAdapter={jest.fn()} onFailure={jest.fn()} />,
  );
  await waitFor(() => expect(mockHlsState.instances).toHaveLength(1));
  const h = mockHlsState.instances[0];
  expect(h.loadSource).toHaveBeenCalledWith(MANIFEST);
  expect(h.attachMedia).toHaveBeenCalledWith(getByTestId('html5-video'));

  // teardown must destroy the instance or its workers/buffers leak
  unmount();
  expect(h.destroy).toHaveBeenCalled();
});

test('native HLS (Safari) gets the manifest as a plain src', async () => {
  jest
    .spyOn(window.HTMLMediaElement.prototype, 'canPlayType')
    .mockReturnValue('maybe');
  const { getByTestId } = render(
    <Html5Mount url={MANIFEST} hls onAdapter={jest.fn()} onFailure={jest.fn()} />,
  );
  expect(getByTestId('html5-video')).toHaveAttribute('src', MANIFEST);
  // give the (never-taken) dynamic-import branch a tick to prove itself idle
  await new Promise((r) => setTimeout(r, 0));
  expect(mockHlsState.instances).toHaveLength(0);
});

test('no native HLS and no MSE fails visibly', async () => {
  mockHlsState.supported = false;
  const onFailure = jest.fn();
  render(<Html5Mount url={MANIFEST} hls onAdapter={jest.fn()} onFailure={onFailure} />);
  await waitFor(() =>
    expect(onFailure).toHaveBeenCalledWith(
      'This browser supports neither native HLS nor Media Source Extensions.',
    ),
  );
  expect(mockHlsState.instances).toHaveLength(0);
});
