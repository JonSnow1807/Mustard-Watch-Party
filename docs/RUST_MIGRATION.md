# Migrating the backend to Rust — a roadmap

## Context

The production backend is **Node/NestJS** and serves all traffic; `relay-go`
and `relay-rs` are studies of only the *sync plane*, neither deployed. A load
study ([relay-rs/README.md](../relay-rs/README.md)) found the runtime win is
real but narrow: at 10k concurrent connections Rust holds ~3× less memory per
connection and ~a fifth the CPU, while **sync quality is identical** (drift is
bounded by protocol + network, not the runtime). The decision to migrate has
been made; this document plans it honestly rather than re-litigating it.

**The honest cost, stated once.** The Node backend is not just the sync plane
the relays cover. It is OAuth with PKCE, JWT with refresh/revocation/elevation,
bcrypt, six Prisma models on Postgres, **Socket.IO** (two namespaces, ack
callbacks, a Redis adapter), guest management, rate limiting, the actor plane,
rooms REST, chat, voice signalling, metrics, and eight scheduled jobs. A
rewrite re-opens the door to every bug already fixed here — this codebase has
closed roughly forty across auth and sync, several security-critical, and most
were "unit-correct code that reached nobody in production." A big-bang rewrite
is how this dies. The plan below is a **strangler-fig**: move pieces where the
win is real, prove each against the existing harness before it carries traffic,
and keep Node serving until each piece is retired.

## The decision the whole migration turns on

The React frontend speaks **Socket.IO + JSON** — named events across two
namespaces (`/` and `/voice`), an ack callback for the clock, chat, voice
signalling, presence, `set-video`, controller succession, room lifecycle — with
the token in the handshake `auth` object. `relay-rs` speaks **raw-WebSocket +
little-endian binary frames** (opcodes `0x01`–`0x07`), token in `?token=`,
one namespace, and covers only clock/join/play/pause/seek. It is a conformance
study of the sync *math*, not a drop-in backend.

So there are two mutually exclusive routes:

**Route A — keep the wire contract.** The Rust backend gets a Socket.IO-
compatible server (Engine.IO handshake, packet framing, namespaces, ack
callbacks, the Redis adapter for multi-instance fan-out) and reimplements
chat, participants, voice, succession, room lifecycle, and the full REST
surface. The frontend does not change. `socketioxide` (Rust) implements the
Socket.IO protocol and has a Redis adapter, so this is feasible; the binary
core of `relay-rs` covers roughly the play/pause/seek/clock/join slice and
**none** of the framing.

**Route B — change the client.** Adopt `relay-rs`'s binary protocol on the
frontend, dropping Socket.IO. This is less Rust server work but forfeits chat,
voice, presence, `set-video`, the video fence, and structured rejections until
each is given a binary representation (they have none today), and it rewrites a
working, tested frontend transport for no user-facing gain.

**Decided: Route A** (2026-08-18). The frontend is mature and correct; the wire
contract is the stable interface everything (frontend, bots, relays) already
depends on. Preserving it lets the *existing* bot fleet and live checks prove
the Rust backend as a fourth conforming target with zero client risk, and lets
the migration run **piece by piece behind the same URLs** rather than as a
flag day. Route B was considered and set aside — it only makes sense if a
future protocol redesign is already wanted for its own reasons, and it would
forfeit chat/voice/presence/`set-video` until each gained a binary form. The
phased plan below assumes Route A throughout (`socketioxide` for the wire).

## What already exists that de-risks this

The parity machinery was built to prove `relay-go`/`relay-rs` match Node, and
it ports directly:

- **The gated bot fleet** ([`sync-harness/`](../sync-harness/)) already speaks
  *both* planes (`--plane node` Socket.IO, `--plane relay` binary) and enforces
  hard gates: P95 drift, drift slope, zero seq gaps, **exact** control-commit
  counts (a double-apply shows as an extra commit), and the reorder witness.
  A Rust backend that speaks either plane is validated by the *same* suite.
- **The exactly-once battery** (`--dup-controls --reorder-controls` +
  `replay-check.ts`) tied 1:1 to `formal/SyncExactlyOnce.tla`.
- **Plane-agnostic security checks**: `relay-revocation-check.mjs` and
  `relay-ingress-check.mjs` accept any binary via `RELAY_BIN`; the auth
  live-checks (`claim-check`, `session-check`, `revocation-check`,
  `verify-guest-limit`) hit a real REST/socket surface and would target the
  Rust one unchanged.
- **The four TLA+ specs + nightly TLC job** as the protocol contract.
- **The Redis Lua scripts** (`video-sync-backend/src/sync/lua/`) are the single
  source of atomic-commit truth and are **language-agnostic** — Redis runs
  them regardless of caller. Keeping them verbatim inherits exactly-once and
  fencing correctness for free, and is why `relay-go`/`relay-rs` already
  conform. **A Rust backend must keep calling the same Lua, not reimplement it.**
- **The JWT contract** (`token-payload.ts`, HS256, same secret, `sub/jti/ver/
  sess/elev/exp`, `exp`/`sess` in seconds) is already shared across REST, WS,
  and the relays. Rust must be wire-compatible so tokens verify across any
  plane still running.

## Phased plan (each phase conformance-gated)

Each phase ships a Rust component behind the same wire contract, is proven by
the harness/live-checks above **before** it takes traffic, and leaves Node able
to take it back. Order is chosen so the highest-confidence, lowest-coupling
pieces go first.

- **Phase 0 — Foundation.** A Rust workspace (`socketioxide` + `axum`, `sqlx`
  against the existing Postgres schema, `redis`/`fred`, `jsonwebtoken`,
  `bcrypt`). Port the shared primitives verbatim in behaviour: the
  `token-payload` contract and `subjectOf`/`versionOf`; `tokenLifetime`'s
  strict duration parser; `media-source` URL classification (via the `url`
  crate); `sync-core/timeline` (`isNewer`, `projectMediaTime`, `applyControl`,
  `snapshot`). A `/health` endpoint reporting `RENDER_GIT_COMMIT` as `revision`
  (the deploy gate requires it; `relay-rs` lacks one). **Gate:** unit tests
  match the TS behaviour on shared vectors.
- **Phase 1 — Sync plane (Socket.IO).** Reimplement `SyncGateway` on
  `socketioxide`: `join-room`, `sync:clock` (ack), `sync:control`,
  `sync:timeline`, the `RoomStateStore` seam calling the **same Lua**, the
  actor plane's lease/fence, `session-ended` eviction. This is where `relay-rs`
  is reused — its Lua wiring, JWT/revocation, and timeline codec — re-dressed
  in Socket.IO framing. **Gate:** the full gated bot fleet on `--plane node`
  against the Rust service, plus the exactly-once battery and `ci.yml`'s
  `sync-regression` job pointed at it.
- **Phase 2 — Auth & REST.** Port `AuthService`, `RevocationService` (snapshot
  + Redis mirror + pub/sub, with the merge-under-lock race fix), the guard,
  rate limiting (`clientIpFrom`'s Cloudflare handling), rooms REST, guest
  sweeper. Google OAuth (PKCE + sealed-state cookie via `oauth2`/`hmac`).
  **Gate:** every `scripts/live-checks/` script against the Rust REST/socket
  surface — they encode the exact behaviours (revocation reaching live sockets,
  refresh rotation, guest claim keeping history) that were unit-correct-but-
  broken before.
- **Phase 3 — Chat, voice, presence, lifecycle.** `send-message`/history,
  the `/voice` namespace WebRTC signalling, participants, `room:controller`
  succession, `room:closed`. **Gate:** live two-client checks (this repo's
  hard-won rule — namespace/handshake bugs make unit-correct code reach nobody).
- **Phase 4 — Cutover & deprecation.** Run Rust and Node side by side behind
  the load balancer on a fraction of traffic; watch the metrics
  (`/metrics` Prometheus parity) and the nightly lab. Shift traffic as
  confidence grows; retire the Node service last, once every live-check and the
  50-bot nightly lab pass against Rust alone.

## Deployment changes

- **`render.yaml` is Node-only** (`env: node`, npm/prisma build). A Rust
  service needs a new service definition (Docker or `env: rust`), a
  `cargo build --release` build, and a start command that owns migrations
  (or leaves Postgres migration to a one-shot).
- **A `/health` with `revision == RENDER_GIT_COMMIT` is mandatory** — both
  `deploy.yml`'s revision gate and `render.yaml`'s health check depend on it.
- **Env surface** carries over: `JWT_SECRET` (same secret, so tokens verify
  across planes during cutover), `REDIS_URL`, and once it serves auth,
  `DATABASE_URL`, `FRONTEND_URL`, `PUBLIC_API_URL`, and the Google creds.
- **A Rust CI job must be added** — none exists today. At minimum
  `cargo build` + `cargo clippy` + `cargo test` + the gated bot fleet +
  the `RELAY_BIN` revocation/ingress checks, mirroring `sync-regression`.
- The `deploy.yml` path filter and `RENDER_DEPLOY_HOOK` need a parallel for
  the Rust service; see [DEPLOY.md](DEPLOY.md) for the existing traps.

## Risks, stated plainly

- **Re-introducing fixed bugs.** The single biggest risk. Mitigation: the
  live-checks and gated fleet are *behavioural specifications* of the bugs
  already fixed — run every one against Rust before it takes traffic, and treat
  a green harness, not a compiling binary, as "done."
- **Socket.IO protocol fidelity.** `socketioxide` must match Engine.IO framing,
  ack semantics, reconnect/`sendBuffer` behaviour the client relies on, and the
  Redis adapter's multi-instance fan-out. Prove it with the `--plane node`
  fleet, which drives real Socket.IO.
- **Two implementations in flight.** During cutover, a protocol or JWT-claim
  change must land in both Node and Rust in lockstep or they diverge — the same
  lockstep discipline the shared Lua already imposes on the relays.
- **The actor plane's fencing** (`SyncActor.tla`) is correctness-critical;
  keeping the `actor_*.lua` verbatim inherits it, as `relay-go` shows.

## Scope note

`shared/sync-core/{clock-estimator,drift-controller,discipline-controller,
player-adapter}` are **client-side** algorithms — not part of the backend
rewrite. The `SyncEvent`/`EventType` Prisma model is dead (never written) and
can be dropped. These trim the surface.
