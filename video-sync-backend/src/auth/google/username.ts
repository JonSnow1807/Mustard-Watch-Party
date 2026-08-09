/**
 * Google gives us a display name ("Chinmay Shrivastava") and an email.
 * `username` here is @unique, NOT NULL, and is what other people see in a
 * room - so a provider sign-in has to manufacture one that is legal, stable
 * enough to recognise, and not already taken.
 */

const MIN = 3;
const MAX = 20;

/**
 * Lowercase, ASCII, `[a-z0-9_]`. Deliberately narrow: this string is
 * rendered in participant lists and chat, and a name that arrives from an
 * external system is exactly the kind of value that should not carry
 * whitespace, combining marks or right-to-left overrides into our UI.
 *
 * Returns '' when nothing survives - a name written entirely in a script we
 * strip is not an error, it just means the caller falls back.
 */
export const slugifyUsername = (input: string): string => {
  const slug = input
    .normalize('NFKD')
    // drop combining marks so "José" degrades to "jose" rather than "jos"
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX);
  return slug.replace(/_+$/g, '');
};

/**
 * Best available basis for a username, in order of how much it looks like a
 * name the person would recognise as theirs.
 */
export const usernameBase = (name?: string, email?: string): string => {
  const fromName = name ? slugifyUsername(name) : '';
  if (fromName.length >= MIN) return fromName;

  const fromEmail = email ? slugifyUsername(email.split('@')[0]) : '';
  if (fromEmail.length >= MIN) return fromEmail;

  return 'watcher';
};

/**
 * The base first, then the base plus a random suffix. Random rather than a
 * counter: a counter needs a read of the current maximum (a race, and a
 * query per attempt), while a suffix drawn from 10^4 collides rarely enough
 * that the caller's retry loop settles immediately - and when it does
 * collide, the next draw is independent.
 *
 * `rand` is injected so the test can pin the sequence.
 */
export function* usernameCandidates(
  base: string,
  rand: () => number = Math.random,
): Generator<string> {
  yield base;
  while (true) {
    const suffix = String(Math.floor(rand() * 10000)).padStart(4, '0');
    // keep room for the suffix rather than letting the DB truncate or the
    // name balloon past what the UI lays out
    yield `${base.slice(0, MAX - suffix.length - 1)}_${suffix}`;
  }
}
