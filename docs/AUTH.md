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

```
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

It is off unless both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set.
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
3. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `PUBLIC_API_URL` on the
   service, then redeploy.

No frontend rebuild is needed: the button is driven by `/auth/providers` at
runtime, so one bundle serves an install with the provider and one without.

## Known gaps

- No token refresh or revocation. A token is good for 12 hours, and a socket
  accepted at connect outlives its token (`docs/SCALING.md`).
- `JWT_EXPIRES_IN` is dead config — the 12h lifetime is hardcoded in
  `auth.module.ts`.
- Linking a provider to an existing account is not implemented; see above.
- `isPublic` on a room is a listing flag, not access control.
