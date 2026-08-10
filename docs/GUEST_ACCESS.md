# Joining without an account — what it would actually take

The UX audit's largest open finding: someone sent an invite link has to
create an account before they can watch anything. This note is the survey I
did before writing any of it, because the shape of the change is decided by
constraints that are already load-bearing, and picking the wrong shape here
is expensive to undo.

Not implemented. This is the analysis, not the design being proposed as
settled.

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
