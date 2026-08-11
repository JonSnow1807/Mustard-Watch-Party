# Joining without an account

The UX audit's largest open finding: someone sent an invite link had to
create an account before they could watch anything.

**Built.** `POST /auth/guest` since #51, and `POST /auth/claim` — keeping the
account you have been using — since #54. What follows is the survey done
before any of it was written, kept because the shape of the change was
decided by constraints that are still load-bearing, and the reasoning is
worth more than the conclusion. Where a section still reads as a proposal,
read it as the argument for what is now there.

## Why it is not a small change

Three things assume a `User` row exists, and each is there for a reason.

**The socket handshake refuses a connection without a verified token.**
`ws-auth.ts` rejects a missing token, an unparseable one, and one with no
subject, before any handler runs. Identity is derived there and never read
off a payload — that is what stopped the chat handler impersonation bug, and
it is why the REST and socket planes cannot drift on who someone is. Any
guest path has to produce something this middleware accepts, not bypass it.

**`Participant.userId` is a foreign key to `User`.** Presence, the
participant list, and the rejoin path all read through it. A guest with no
row cannot be a participant without either a nullable FK (which pushes a
null check into every read) or a real row.

**The token IS the identity, on both planes.** REST and the socket verify the
same HS256 `{ sub, name }`, and `relay-go` verifies its HMAC. There is one
contract in `token-payload.ts` precisely so there is nothing to keep in sync.

## The two shapes

**A. A real but disposable User row.** The guest gets a `User` with no
password (already possible — the column is nullable for Google sign-in) and
a generated name, and a normal token. Everything downstream is unchanged:
the handshake passes, the FK is satisfied, presence works, chat attributes
correctly.

Costs: rows accumulate for every guest visit and need a reaper; the
`username` unique constraint needs a collision-tolerant generator (the Google
path already has one — `google/username.ts`); and "guest" has to be visible
in the UI, or people will not understand why their room disappeared when they
next open the site.

**B. A distinct guest token with no row.** A token with a `guest:` subject
and a claim naming the room, accepted by the handshake but never resolvable
to a `User`.

Costs: `Participant` needs a nullable `userId` plus a display name, and every
read of it grows a branch. Chat messages have the same problem — `ChatMessage.userId`
is also a FK. This is the cleaner data model in the abstract and the larger
change in practice, because it touches every place identity is read rather
than one place it is created.

## What I would want decided before writing it

1. **Should a guest be scoped to one room?** B makes that natural, A does not
   enforce it without extra work. A guest token that works everywhere is a
   weaker thing than the invite implies.
2. **Do guest messages persist?** If yes, `ChatMessage` needs the same
   treatment as `Participant`, and deleting the guest later orphans history.
3. **What happens when a guest signs up properly?** Carrying their identity
   across is easy under A (promote the row) and hard under B (there is no row
   to promote).

## Recommendation

A, with a reaper — but only if the answer to (1) is "no, a guest is a
lightweight account". If a guest must be confined to the room they were
invited to, B is the honest model and the extra work is the price of not
lying about what the token means.

Either way this wants to be its own PR with its own tests, not an
afterthought bolted onto a UX sweep.

## Keeping the account (`POST /auth/claim`)

A guest session is a real row with real history hanging off it, and it expires
in twelve hours with no password to get back in with. Claiming is the door out
of that, and it is an **UPDATE, not an insert**: the row keeps its id.

That is the whole design. `ChatMessage.userId` and `Participant.userId` are
foreign keys — creating a fresh account and copying nothing would leave last
night's conversation attributed to a name about to be swept, and the messages
people are still reading would go blank.

**The guard is on the row, not on the caller's word.** The route is
authenticated, but the service re-reads `isGuest` and the `update` is narrowed
by `isGuest: true` as well — check-then-act has a window, and the guard has to
be in the write or a race can slip a full account through it. A caller whose
row is already a full account gets 403, not 409: telling someone holding a
stolen token which accounts are claimable is a free enumeration oracle.

Verified against a real database, not mocks — `scripts/live-checks/claim-check.mjs`.
The unit tests assert the service calls `update()` with the same id, which is
the mock agreeing with itself. Only Postgres can say whether the chat rows
still point at a live user afterwards.

**Three things that check got wrong before it got them right**, all of them the
harness rather than the product: chat history is served over the socket and not
in the room's REST body; the participant row is removed on disconnect, so
closing the socket before looking shows an empty list; and deleting the room at
the end removes the very chat rows a later query was inspecting. Each looked
exactly like data loss. A live check that does not assert its own setup will
report its own failures as yours.

### What the survey left open, and what the code decided

A review of this document caught three places where the analysis was looser
than the implementation turned out to be. Recorded rather than quietly
tightened, because the gap between them is the interesting part:

- **The survey never specified an email for a disposable user.** `User.email`
  is non-null and unique, so "a generated username and a nullable password" is
  not enough to insert a row - the argument had a hole the code had to fill.
  It fills it with `randomUUID()@guest.invalid`: collision-safe by
  construction, and `.invalid` is reserved by RFC 2606 so it can never route
  anywhere real.
- **It implied the socket handshake needs a `User` row.** It does not - the
  handshake validates a signed token with `sub` and `name` and attaches the
  identity, with no database lookup (`jwt-auth.guard.spec.ts`). The
  persistence constraints are `Participant.userId` and `ChatMessage.userId`,
  which is a narrower and more accurate statement of why a row is needed.
- **Option C (row-less guests) was under-specified.** A `guest:` subject gives
  a participant or message no stable identity across reconnects, so history
  and de-duplication have nowhere to hang. That is a real reason it was not
  chosen, and the survey did not say it.

## Claiming with Google instead of a password

`POST /auth/google/link-start` — for someone who would rather not invent
another password. Same rule underneath: the row keeps its id.

Not quite the *same* outcome as `/auth/claim`, and the difference is a one-way
door: a linked account keeps `password: null`, and there is no path to add one
later. Google becomes the only way in. That matches how Google-created
accounts already behave here, so it is consistent rather than surprising - but
someone who loses access to that Google account loses the account, and no
password reset exists to rescue them.

**Why it is a POST that returns a URL** rather than a link the browser
follows. A navigation cannot carry an `Authorization` header, and the
alternative — the token in a query string — writes a credential into access
logs and `Referer` headers. So the browser asks for the URL and goes there
itself.

**The id is sealed into the OAuth state cookie**, and it is the id the guard
verified from the bearer token — never anything the caller said about
themselves. A caller who could nominate the account would be able to attach
their own Google identity to somebody else's.

**Order of checks matters.** The provider link is examined before anything is
written: a Google account already attached to a real account must not be
quietly moved onto a guest row, because that is an account takeover using the
victim's own credentials. Same for the address.

Failures come back as **codes in the redirect fragment**, not sentences —
`link_provider_taken`, `link_email_taken`, `link_not_guest`. That is the
existing contract for this channel and it is deliberate: the API does not
know how the frontend words things, and a code cannot leak anything about the
account it refused. The first version of this sent the message text and had
to be corrected.

### Still not built

- **A full account cannot add or change a provider.** Only guests can link.
  Doing it for a real account needs a re-authentication step that does not
  exist here, and adding the feature without it would let a stolen token
  attach an attacker's Google identity to someone's account.
- **Merging two accounts.** If the Google address already has an account, the
  answer is "sign in with that one" — we cannot tell from here that both are
  the same person.
- **Adding a password to a linked account.** Linking leaves `password: null`
  with no way to set one afterwards, so Google is the only way back in and
  there is nothing for a reset flow to reset. Anyone who wants both should
  claim with a password instead; the two paths do not compose.
