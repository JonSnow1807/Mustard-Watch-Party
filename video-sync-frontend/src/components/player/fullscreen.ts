/**
 * Fullscreen, as a function rather than a click handler.
 *
 * Pulled out of the player so it can be tested at all: a browser refuses
 * `requestFullscreen` outside a real user gesture (and refuses it outright
 * in an automated tab), so the only way to check the branching is to hand it
 * the document rather than reach for the global one.
 */
export interface FullscreenTarget {
  requestFullscreen?: () => Promise<void>;
}

export interface FullscreenDocument {
  fullscreenElement: Element | null;
  exitFullscreen: () => Promise<void>;
}

/**
 * Toggle, and swallow refusal.
 *
 * Safari before 16.4, an embedded webview, an iframe without the
 * `allowfullscreen` attribute and an automated tab all reject the request.
 * That is the browser declining, not a fault to surface: the page carries on
 * exactly as it was, and the button simply did nothing visible.
 */
export const toggleFullscreen = async (
  element: FullscreenTarget | null,
  doc: FullscreenDocument,
): Promise<boolean> => {
  if (!element) return false;
  try {
    if (doc.fullscreenElement) {
      await doc.exitFullscreen();
      return false;
    }
    if (!element.requestFullscreen) return false;
    await element.requestFullscreen();
    return true;
  } catch {
    return false;
  }
};
