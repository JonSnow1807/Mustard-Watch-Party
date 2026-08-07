// GENERATED FILE — do not edit here.
// Canonical source: /shared/. Regenerate: node scripts/sync-shared.mjs
// Source classification and URL validation for room videos - the ONE place
// that decides what a videoUrl means. Consumed by the player (which mount to
// render), the REST DTOs, and the gateway's set-video guard; drift between
// those three is impossible by construction because they all import this.
//
// Boundary: validation bounds SIZE and SHAPE, never playability.
// `https://example.com/not-a-video` is valid input by design - unknown URLs
// are attempted as HTML5 media and fail visibly in the player, because
// signed CDN links (extensionless, query-string-authenticated) are
// indistinguishable from garbage by inspection. The player's failure card
// owns that outcome; this module only refuses inputs that could not
// possibly be fetched or that no mount would accept.
//
// Pure and DOM-free (WHATWG URL only) so the same code runs in the backend
// gateway, jest, and the browser bundle.

export type MediaSource =
  | { kind: 'none'; reason: 'empty' | 'unsupported' }
  | { kind: 'youtube'; videoId: string }
  | { kind: 'vimeo'; videoId: string; hash?: string } // hash: unlisted-video key
  | { kind: 'hls'; url: string }
  | { kind: 'file'; url: string; container: 'mp4' | 'webm' | 'ogg' | 'unknown' };

/**
 * Bounds what a videoUrl may look like at the door (REST create/update and
 * the set-video control). The cap matters because the URL becomes
 * Timeline.videoId and rides EVERY sync:timeline broadcast to every client
 * in the room - it bounds store and wire, not just sanity. 2048 is the
 * interoperable URL limit; signed CDN URLs (500-1500 chars) fit.
 */
export const VIDEO_URL_MAX_LEN = 2048;

/**
 * Shape floor: an absolute http(s) URL or a same-origin /media/ path.
 * Single-token garbage ("hello") is refused here; extensionless signed
 * links pass and are the player's problem (fail-visibly). Bare 11-char
 * YouTube ids are additionally admitted by isAcceptableVideoUrl.
 */
export const VIDEO_URL_SHAPE = /^(https?:\/\/\S+|\/?media\/\S+)$/;

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

// Dummy base so relative inputs ("/media/x.mp4") parse; the reserved
// .invalid TLD guarantees the host never collides with a real provider.
const RELATIVE_BASE = 'https://relative.invalid/';

// Hostnames checked AFTER stripping a leading "www.".
const YT_HOSTS = ['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtube-nocookie.com'];

function hostOf(u: URL): string {
  const h = u.hostname.toLowerCase();
  return h.slice(0, 4) === 'www.' ? h.slice(4) : h;
}

function segmentsOf(u: URL): string[] {
  return u.pathname.split('/').filter((s) => s.length > 0);
}

function extractYouTubeId(u: URL, host: string): string | null {
  if (host === 'youtu.be') {
    const seg = segmentsOf(u)[0];
    return seg !== undefined ? seg : null;
  }
  const segs = segmentsOf(u);
  if (segs[0] === 'watch') return u.searchParams.get('v');
  if (
    segs.length >= 2 &&
    (segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live' || segs[0] === 'v')
  ) {
    return segs[1];
  }
  return null;
}

function classifyVimeo(u: URL, host: string): MediaSource {
  const segs = segmentsOf(u);
  if (host === 'player.vimeo.com') {
    if (segs[0] === 'video' && segs[1] !== undefined && /^\d+$/.test(segs[1])) {
      const h = u.searchParams.get('h');
      return h !== null && h !== ''
        ? { kind: 'vimeo', videoId: segs[1], hash: h }
        : { kind: 'vimeo', videoId: segs[1] };
    }
    return { kind: 'none', reason: 'unsupported' };
  }
  // vimeo.com/<digits>[/<unlisted-hash>]
  if (segs[0] !== undefined && /^\d+$/.test(segs[0])) {
    const h = segs[1];
    return h !== undefined && /^[A-Za-z0-9]+$/.test(h)
      ? { kind: 'vimeo', videoId: segs[0], hash: h }
      : { kind: 'vimeo', videoId: segs[0] };
  }
  return { kind: 'none', reason: 'unsupported' };
}

/** Extension rules run on URL.pathname only - `?signature=` query strings never interfere. */
function byExtension(u: URL, raw: string): MediaSource | null {
  const p = u.pathname.toLowerCase();
  if (p.slice(-5) === '.m3u8') return { kind: 'hls', url: raw };
  if (p.slice(-4) === '.mp4') return { kind: 'file', url: raw, container: 'mp4' };
  if (p.slice(-5) === '.webm') return { kind: 'file', url: raw, container: 'webm' };
  if (p.slice(-4) === '.ogg') return { kind: 'file', url: raw, container: 'ogg' };
  return null;
}

/**
 * Classify a room's videoUrl into the source a player mount can act on.
 * `url` fields carry the RAW input, never a re-encoded parse - signed URLs
 * must reach the media element byte-for-byte.
 *
 * Ordered rules:
 *  1. empty/whitespace -> none/empty ('' is the room's null sentinel)
 *  2. bare 11-char id -> youtube (legacy rooms stored ids, not URLs)
 *  3. YouTube/Vimeo by hostname; a provider host WITHOUT an extractable id
 *     is none/unsupported - a <video> fetch against a provider page is
 *     doomed, so don't attempt it
 *  4. pathname extension: .m3u8 -> hls; .mp4/.webm/.ogg -> file
 *  5. anything else that parsed -> file/unknown (attempt-and-fail-visibly)
 */
export function classifyMediaSource(raw: string | null | undefined): MediaSource {
  const s = (raw !== null && raw !== undefined ? raw : '').trim();
  if (s === '') return { kind: 'none', reason: 'empty' };
  if (YT_ID.test(s)) return { kind: 'youtube', videoId: s };

  let u: URL;
  try {
    u = new URL(s, RELATIVE_BASE);
  } catch {
    // not even parseable relative to a base (e.g. "http://[bad") - nothing
    // could fetch this, so it is refused rather than attempted
    return { kind: 'none', reason: 'unsupported' };
  }

  const host = hostOf(u);
  if (host === 'youtu.be' || YT_HOSTS.indexOf(host) !== -1) {
    const id = extractYouTubeId(u, host);
    // "videoseries" is /embed/'s playlist pseudo-id: 11 chars of the id
    // charset but never a video - loading it would only produce a player
    // error, so refuse it as unsupported instead
    if (id !== null && id !== 'videoseries' && YT_ID.test(id)) {
      return { kind: 'youtube', videoId: id };
    }
    return { kind: 'none', reason: 'unsupported' };
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') return classifyVimeo(u, host);

  const ext = byExtension(u, s);
  if (ext !== null) return ext;
  return { kind: 'file', url: s, container: 'unknown' };
}

/**
 * The admission rule for videoUrl at every write path (REST DTOs, gateway
 * set-video guard, frontend form). Strict on the string AS GIVEN - callers
 * trim before validating, and surrounding whitespace fails the anchors.
 */
export function isAcceptableVideoUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > VIDEO_URL_MAX_LEN) return false;
  if (!VIDEO_URL_SHAPE.test(raw) && !YT_ID.test(raw)) return false;
  return classifyMediaSource(raw).kind !== 'none';
}
