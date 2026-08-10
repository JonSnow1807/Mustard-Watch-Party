/**
 * Where to send someone after they sign in.
 *
 * A guest arrives on an invite link, is asked to sign in, and has to end up
 * in the room they were invited to - not on the home page with the code
 * gone, which is what happened before this existed. The destination travels
 * as a query parameter (`?next=/room/ABC`) so it survives the full-page
 * navigation the Google flow makes, which `location.state` would not.
 *
 * The value is attacker-supplied by construction: it rides in a link anyone
 * can send. So it is filtered on the way in AND on the way out, and only
 * ever names a path on this site - the same rule the server applies to the
 * OAuth `returnTo` in google-oauth.service.ts.
 */
export const RETURN_TO_PARAM = 'next';

export const safeReturnTo = (value: string | null | undefined): string | null => {
  if (!value) return null;
  // A path, not a URL. '//evil.example' is protocol-relative and would leave
  // the site; a backslash is treated as a slash by some browsers.
  if (!value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\')) return null;
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return null;
  }
  return value.slice(0, 512);
};

/** Read the destination off a location's query string, filtered. */
export const readReturnTo = (search: string): string | null =>
  safeReturnTo(new URLSearchParams(search).get(RETURN_TO_PARAM));

/** Build a sign-in URL that remembers where the person was heading. */
export const loginUrlFor = (destination: string): string => {
  const safe = safeReturnTo(destination);
  return safe
    ? `/login?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}`
    : '/login';
};
