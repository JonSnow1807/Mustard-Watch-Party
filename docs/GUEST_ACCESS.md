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

### Still not built

- **Linking Google to a guest row.** Claiming takes a password. Someone who
  would rather use Google has to make a separate account, which is the case
  this whole feature exists to avoid.
- **Password strength beyond eight characters**, and `register` validates even
  less — claim checks a name pattern, an address shape and a length; register
  checks none of them. Fixing one door and not the other would read as though
  the other had been considered.
