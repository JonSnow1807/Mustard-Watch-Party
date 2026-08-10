import { toggleFullscreen } from './fullscreen';

const makeDoc = (fullscreenElement: Element | null = null) => ({
  fullscreenElement,
  exitFullscreen: jest.fn().mockResolvedValue(undefined),
});

describe('toggleFullscreen', () => {
  it('asks the shell to go fullscreen when nothing is fullscreen', async () => {
    const el = { requestFullscreen: jest.fn().mockResolvedValue(undefined) };
    const doc = makeDoc(null);

    await expect(toggleFullscreen(el, doc)).resolves.toBe(true);
    expect(el.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it('exits when something already is', async () => {
    const el = { requestFullscreen: jest.fn() };
    const doc = makeDoc({} as Element);

    await expect(toggleFullscreen(el, doc)).resolves.toBe(false);
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(el.requestFullscreen).not.toHaveBeenCalled();
  });

  it('swallows a browser that refuses', async () => {
    // Safari <16.4, an embedded webview, an iframe without allowfullscreen,
    // and an automated tab all reject this - the page must carry on, not
    // surface an error nobody can act on
    const el = {
      requestFullscreen: jest
        .fn()
        .mockRejectedValue(new Error('Permissions check failed')),
    };

    await expect(toggleFullscreen(el, makeDoc(null))).resolves.toBe(false);
  });

  it('swallows a failing exit too', async () => {
    const doc = makeDoc({} as Element);
    doc.exitFullscreen.mockRejectedValue(new Error('nope'));

    await expect(toggleFullscreen({}, doc)).resolves.toBe(false);
  });

  it('does nothing without a shell, or without support', async () => {
    await expect(toggleFullscreen(null, makeDoc(null))).resolves.toBe(false);
    // an old browser with no requestFullscreen at all
    await expect(toggleFullscreen({}, makeDoc(null))).resolves.toBe(false);
  });
});
