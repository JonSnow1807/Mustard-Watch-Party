import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { VimeoMount } from './VimeoMount';

const mockVimeoState: {
  failReady: boolean;
  instances: Array<{
    options: Record<string, unknown>;
    listeners: Map<string, (data?: unknown) => void>;
    destroy: jest.Mock;
  }>;
} = { failReady: false, instances: [] };

jest.mock('@vimeo/player', () => {
  // untyped internals: babel's out-of-scope guard for mock factories
  // rejects even identifiers appearing in TYPE annotations
  class FakePlayer {
    options: Record<string, unknown>;
    listeners = new Map();
    destroy = jest.fn(() => Promise.resolve());
    constructor(_el: HTMLElement, options: Record<string, unknown>) {
      this.options = options;
      mockVimeoState.instances.push(this);
    }
    on(event: string, cb: Function) {
      this.listeners.set(event, cb);
    }
    off() {}
    ready() {
      return mockVimeoState.failReady
        ? Promise.reject(new Error('Because of its privacy settings, this video cannot be played here.'))
        : Promise.resolve();
    }
    getDuration() {
      return Promise.resolve(0);
    }
  }
  return { __esModule: true, default: FakePlayer };
});

beforeEach(() => {
  mockVimeoState.failReady = false;
  mockVimeoState.instances.length = 0;
});

test('delivers an adapter once the player is ready', async () => {
  const onAdapter = jest.fn();
  const { unmount } = render(
    <VimeoMount videoId="76979871" onAdapter={onAdapter} onFailure={jest.fn()} />,
  );
  await waitFor(() => expect(onAdapter).toHaveBeenCalled());
  expect(onAdapter.mock.calls[0][0]).not.toBeNull();
  expect(mockVimeoState.instances[0].options).toMatchObject({
    id: 76979871,
    controls: false,
    autopause: false,
  });

  unmount();
  expect(mockVimeoState.instances[0].destroy).toHaveBeenCalled();
  expect(onAdapter).toHaveBeenLastCalledWith(null);
});

test('an unlisted hash rides the url form the SDK understands', async () => {
  render(
    <VimeoMount
      videoId="76979871"
      hash="9b1d4c2f8a"
      onAdapter={jest.fn()}
      onFailure={jest.fn()}
    />,
  );
  await waitFor(() => expect(mockVimeoState.instances).toHaveLength(1));
  expect(mockVimeoState.instances[0].options.url).toBe(
    'https://vimeo.com/76979871/9b1d4c2f8a',
  );
  expect(mockVimeoState.instances[0].options.id).toBeUndefined();
});

test('a private video fails visibly with the SDK message', async () => {
  mockVimeoState.failReady = true;
  const onFailure = jest.fn();
  render(
    <VimeoMount videoId="76979871" onAdapter={jest.fn()} onFailure={onFailure} />,
  );
  await waitFor(() =>
    expect(onFailure).toHaveBeenCalledWith(
      'Because of its privacy settings, this video cannot be played here.',
    ),
  );
});
