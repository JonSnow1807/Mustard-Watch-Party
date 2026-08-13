# Authentication

Two ways in, one identity out.

Whichever door someone comes through, they leave with the same thing: an
HS256 JWT carrying `{ sub: userId, name: username }`. That token is the only
credential the rest of the system knows about — the REST guard verifies it,
the Socket.IO handshake verifies it, and `relay-go` verifies its HMAC. The
contract lives in one file (`src/auth/token-payload.ts`) and both planes
import it, so there is no second definition to drift.

## Password sign-in

`POST /api/auth/register` and `POST /api/auth/login`. bcrypt, cost 10.
Unchanged by anything below.

## Google sign-in

Server-side authorization code flow with PKCE, terminating on the API. The
browser goes to Google and comes back to us; Google's tokens never reach the
frontend, and nothing from Google is ever presented to the socket plane.

```text
browser ──GET /api/auth/google/start──▶ API
                                        ├─ mints state + PKCE verifier
                                        ├─ Set-Cookie: mw_oauth (sealed, httpOnly, 10 min)
                                        └─ 302 ▶ accounts.google.com
browser ──consent──▶ Google ──302 with ?code&state──▶ /api/auth/google/callback
                                        ├─ cookie must open, and state must match
                                        ├─ code + verifier ──▶ Google token endpoint
                                        ├─ id_token verified (signature, iss, aud, exp)
                                        ├─ find or create the local user
                                        └─ 302 ▶ mustard.watch/auth/callback#token=…
browser ──GET /api/auth/me with that token──▶ profile, then it is a session
```

### Why each piece is the way it is

**The token comes back in the fragment, not the query string.** Fragments are
never sent to a server: not in the request line, not in a `Referer`, not into
anyone's access log. The callback page then calls `history.replaceState` so it
does not survive into history or a copied URL either.

**The `mw_oauth` cookie is sealed with a derived key, not the JWT secret
itself.** Same underlying secret, different HMAC key
(`HMAC(secret, "mustard:oauth-state:v1")`). A sealed state and an access token
must never be interchangeable in either direction, and deriving the key makes
that structural rather than a thing to remember. `oauth-state.spec.ts` pins it
from both sides.

**`SameSite=Lax`, not `Strict`.** The browser arrives at the callback from
`accounts.google.com` — a cross-site navigation. `Strict` would withhold the
one cookie the callback exists to check. `Lax` still covers top-level GET
navigation, which is exactly this hop.

**Nothing is stored server-side between the two hops.** The cookie *is* the
flow state, so any instance behind the load balancer can finish a flow another
instance started.

**`PUBLIC_API_URL` is explicit.** Google matches `redirect_uri` against the
console entry character for character, and a service behind a proxy cannot
derive its own external origin from a request. For production that is
`https://api.mustard.watch/api/auth/google/callback`.

**`returnTo` is filtered on both ends.** It is attacker-supplied by
construction — it rides in a link — so the server keeps only same-site paths
(no scheme, no `//`, no backslash, no control characters) and the callback
page checks again rather than trusting the fragment it was handed.

### The account-linking decision

**A Google identity is looked up by `(provider, subject)`. Never by email.**

If the email on a Google account already belongs to a local account, we refuse
the sign-in and say so. We do not link the two.

This looks unfriendly, and it is deliberate. We have never verified an email
address on a password account — registration accepts whatever is typed. So
anyone could have registered `you@example.com` before you did. If Google
sign-in auto-linked on a matching address, that person would keep their
password into what is now your account, forever, and neither of you would see
anything unusual happen. Refusing costs one confusing moment for a real
person who owns both; linking costs the account.

The way out for a genuine collision is to sign in with the password. An
explicit "link Google to this account" action, taken while already signed in,
is the correct fix and is not built yet.

Two consequences worth knowing:

- `User.password` is nullable. An account that only ever arrived through
  Google has no password, and `login` checks for null **before** bcrypt —
  `bcrypt.compare(x, null)` throws, and a 500 there would tell an enumerator
  exactly which accounts are provider-only. Same 401 either way.
- The email lookup is case-insensitive, but the column's uniqueness is not. A
  P2002 on `email` at insert time is therefore reported as `email_taken` too,
  not as a 500.

### Failure codes

The callback always ends in a redirect — someone mid-sign-in should never land
on a JSON error body at an origin they have never seen. Failures arrive as
`#error=<code>`, and the frontend owns the wording:

| code | meaning |
| --- | --- |
| `denied` | declined at Google's consent screen |
| `state` | no cookie, tampered cookie, expired flow, or state mismatch |
| `unverified` | Google will not vouch for the email |
| `email_taken` | a local account already owns that address |
| `exchange` | Google rejected the code, or we could not reach it |

`unverified` is not paranoia about takeover — we never link by email, so it
cannot cause one. It stops an unverified address from *squatting* one its
real owner has not registered yet, and Google confirming ownership is free.

## Turning Google sign-in on

It is off unless **all three** of these hold:

| variable | why it gates the provider |
| --- | --- |
| `GOOGLE_CLIENT_ID` | no credential, no flow |
| `GOOGLE_CLIENT_SECRET` | same |
| `FRONTEND_URL` | where the callback sends the browser back to |

`FRONTEND_URL` is easy to overlook because it is optional everywhere else and
falls back to `http://localhost:3001`. That fallback is right on a laptop and
a trap in production: the provider would look enabled, and the callback would
hand a real person's token to whatever happens to be listening on **their**
machine. So a loopback origin outside a local `NODE_ENV` disables Google
sign-in and logs why, rather than redirecting anyone there — the same
fail-closed rule `configuration.ts` applies to secrets. Its first entry is the
canonical site; later entries are CORS previews and never receive a token.

Off means: `GET /api/auth/providers` reports `{ google: false }`, the frontend
does not render the button, and `/api/auth/google/*` returns 404. CI, the sync
harness and a fresh local checkout all run in that state, which is why none of
them needed changing.

To enable it:

1. Google Cloud console → **APIs & Services → Credentials → OAuth client ID**,
   type *Web application*.
2. Authorised redirect URI — exactly, including `/api`:
   `https://api.mustard.watch/api/auth/google/callback`
   (locally: `http://localhost:3000/api/auth/google/callback`)
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_API_URL` and
   `FRONTEND_URL` on the service, then redeploy. `FRONTEND_URL` must lead with
   the canonical origin (`https://mustard.watch,...`) — if it is missing the
   provider stays off by design, and the log says so.

No frontend rebuild is needed: the button is driven by `/auth/providers` at
runtime, so one bundle serves an install with the provider and one without.

## Rate limiting an endpoint that does not know who you are

`POST /auth/guest` creates a database row for anyone who asks, so it is
limited. Getting the *key* right took three attempts and two of them shipped,
which is worth more than the rule itself.

**Take one — leftmost `x-forwarded-for`.** Wrong, and it is the classic
mistake: that entry is written by whoever is calling. Twelve requests with
twelve invented values bought twelve separate allowances. A local test would
never have caught it, because locally there is no proxy at all.

**Take two — the last entry**, on the theory that our proxy appends the peer
it saw, pushing any forged value leftward. Sound for a one-hop chain, and it
passed locally. Production disagreed: **fifteen requests from one machine
with no forged header at all, against a capacity of ten, were all admitted**.
The limiter was not engaging for *anyone*. One instance, `NODE_ENV=production`,
so the key was that last entry — and it varies per request, because the
platform appends its own hop from a pool. Every request got a fresh bucket.

**Take three — the rightmost address that could belong to a person**, walking
the chain from the right and skipping private, loopback, link-local and CGNAT
ranges. This does not depend on knowing the hop count, which is the fact that
kept being wrong and cannot be checked from outside. A caller can only
*prepend*, so the rightmost public entry is still theirs; a forged
private-looking value is skipped as a hop.

Its cost, stated rather than discovered later: if the platform's own last hop
is public, everyone behind it keys together and is limited as one caller.
Coarse — but it fails toward refusing rather than toward unbounded row
creation.

Underneath it sits a **keyless bucket** (300/hour for the instance) that no
header can move a caller out of. It is not a substitute for per-caller
limiting; it is the floor under it, sized to be invisible to a room of people
joining a film.

**The lesson worth keeping: a rate limiter cannot be verified locally.** Its
whole behaviour depends on infrastructure that only exists in production.
Both wrong versions passed their unit tests.

## Revocation

A token can be taken out of circulation before it expires. Two levers, because
they answer different questions:

| | `POST /auth/logout` | `POST /auth/logout-all` |
|---|---|---|
| Scope | this one session | every session this account has |
| Mechanism | the token's `jti` is recorded as revoked | the user's `tokenVersion` is bumped past what existing tokens claim |
| For | signing out | a token that may have leaked |

**The snapshot, and why the guard still does no IO.** Both planes check
revocation on every request and every handshake, and both were built to do no
database lookup at all. So `RevocationService` holds an in-memory snapshot —
each revoked `jti` until the token it refuses would have expired anyway, and
the users who have ever revoked everything. (Twelve hours is only the default
lifetime; `JWT_EXPIRES_IN` moves it, and the retention moves with it.) Both sets are small by construction; for most deployments the
second is empty. The check is a `Set.has` and a `Map.get`.

**Postgres is the truth, Redis is only the news.** Revocation that forgets on
restart is not revocation, and this deployment treats Redis as a cache that
may be absent. So records go to Postgres; Redis pub/sub, when present, tells
the other instances within a round trip. Without it they converge on the next
refresh.

**The honest staleness bound is 30 seconds.** If the pub/sub message never
arrives — Redis down, a dropped subscription, an instance that booted while it
was unreachable — another instance keeps honouring a revoked token until its
next refresh. Thirty seconds, not twelve hours.

**Sockets are closed, not just refused.** A connection authenticates once and
is then trusted while it stays open, which used to mean signing out stopped
the REST calls and left the person watching along. Revoking now closes the
matching connections on both namespaces, and a periodic sweep closes any whose
token has simply expired. The client is told `session-ended` with a reason
first — a silent disconnect is indistinguishable from a blip, and the retry
loop would reconnect forever with a dead token.

**What is deliberately not covered**

- ~~`relay-go` does not check revocation~~ — closed, and the reason it was
  ever listed as unclosable was false: this doc claimed the relay "has no
  database or Redis connection", but the relay executes the shared Lua
  against the **same Redis** as everything else (docs/RELAY.md). The backend
  now mirrors the revocation snapshot into Redis (`revoked:jti`,
  `revoked:userver`, rebuilt atomically on every refresh); the relay checks
  the mirror at accept, subscribes to `mustard:revocations` for immediate
  eviction, and sweeps every 30s for revocations it missed and for tokens
  that simply expired — a relay connection used to outlive its token
  indefinitely, since `exp` was never even required there. Postgres remains
  the only durable record. If Redis flushes, the relay falls open to
  signature-only **until the mirror is rebuilt** — one refresh interval when
  the next refresh succeeds, longer if Postgres or Redis stay unreachable,
  since nothing here has a completion deadline. The bound is conditional on
  a healthy refresh, not a hard ceiling; a backend instance that missed a
  pub/sub message carries the same conditional bound.
- **A token with no `jti`** — issued before this existed — cannot be revoked
  individually. `logout` reports `{revoked: false}` rather than claiming a
  success that did nothing. `logout-all` still reaches it.
- **Signing out is best-effort on the client.** The local session is dropped
  first and unconditionally; if the revoke call fails, the person is still
  signed out of that machine and the token dies on its own schedule.

## Sessions: sliding, bounded, and endable

`POST /auth/refresh` trades a live token for a fresh one. Three rules make
it safe where a naive slide would not be:

- **Rotation.** The new token gets a new `jti` and the old one is revoked in
  the same call. A stolen copy is now WORTH LESS than before refresh
  existed: the first party to refresh — victim or thief — kills the other's
  copy, and a twelve-hour theft window shrinks to the gap between
  refreshes. This is what made the old "no lifetime extension" rule
  obsolete: it was written when revocation did not exist.
- **The absolute cap.** Tokens carry `sess`, the session's birth, preserved
  verbatim across refreshes. Thirty days after first sign-in, refresh
  refuses and the person signs in again. A cap anchored to anything
  refreshable is not a cap; pre-`sess` tokens anchor to their own `iat`,
  the honest floor.
- **Elevation cannot slide.** Five-minute re-auth tokens are refused by
  refresh outright.

The client refreshes at ~90% of token life. The socket reconnects once per
refresh (~11h) — the price of not being signed out mid-film at hour twelve.

## Re-authentication: the gate in front of credential changes

The scenario every rule here serves: **someone else is holding a copy of
the token.** A bearer token alone must not be able to add a sign-in method
or change a password, because those are exactly the moves that turn a
stolen session into a stolen account.

| account state | to link Google | to set/change password |
|---|---|---|
| has a password | current password | current password |
| Google only | (already linked) | fresh Google re-auth → 5-min elevated token |
| guest | ungated (the session IS the identity) | — (claim first) |

The elevated token is minted only after the OAuth callback proves the
returning Google subject is THIS account's linked identity
(`reauth_mismatch` otherwise), travels in the redirect fragment under its
own name (`elev`, never `token` — the callback page parks it in
sessionStorage and does not adopt it as a session), and is spent by
`POST /auth/set-password` within five minutes or not at all.

**Setting or changing a password ends every other session** — the
`tokenVersion` bump rides the same database write as the new hash, so
there is no window where the password changed but an attacker's token
still works. The caller alone continues, on the token the response carries.

## Known gaps

- No token **refresh**. A session ends when its token expires; there is no
  way to extend one without signing in again.
- ~~`JWT_EXPIRES_IN` is dead config~~ — fixed. Tokens **default** to `12h` and
  a deployment can change that by setting the variable; it is no longer a
  fixed lifetime. `12h` is what was hardcoded while the config file
  advertised `7d` to nobody. Raising it raises how long a stolen token is
  useful, and there is still no revocation, so it is not a free knob. The
  value is validated at boot: a plain number means seconds, durations must be
  lowercase (`12h`, `30m`), and anything else refuses to start — because
  `jsonwebtoken` reads a unitless string as *milliseconds*, so `3600` would
  otherwise mean 3.6 seconds.
- ~~Linking a provider is guests-only~~ — full accounts link Google now,
  gated on the current password (see Re-authentication above). Swapping or
  UNLINKING a provider is still not built: unlink needs "would this leave
  the account with no way in" reasoning that deserves its own design.
- ~~A linked account has no password and no way to acquire one~~ — closed:
  `POST /auth/set-password` behind the Google re-auth gate. The one-way
  door is now a door.
- **Account merging stays unbuilt, on purpose.** Two accounts that might be
  one person mean migrating chat/participant/room foreign keys across
  identities we cannot verify are the same person, destructively. "Sign in
  with the account that owns that email" costs a sign-in; a wrong merge
  costs someone their history.
- `isPublic` on a room is a listing flag, not access control.
- The "is this address already taken" check is a case-insensitive `findFirst`,
  which Postgres answers with a sequential scan — the `email` index is
  case-sensitive and cannot serve it. It runs once per *first* Google sign-in
  per account, never on the returning path, so it is not on a hot path. Making
  it indexable needs `citext` or a `lower(email)` expression index plus a raw
  query, since Prisma's insensitive `equals` compiles to `ILIKE` and would not
  use the index anyway. Not worth that machinery at this table size; revisit if
  the user table grows.
