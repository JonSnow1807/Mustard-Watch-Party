# relay-go — a second implementation of the sync plane

A minimal Go relay speaking **raw WebSockets with hand-rolled binary
framing**, goroutine-per-connection, executing the **literal same Lua
files** as the Node backend (`video-sync-backend/src/sync/lua/`) against the
same Redis. It exists as a measured systems study and as the second
conforming implementation of the TLA+-checked protocol — not as a
mixed-mode deployment.

## Conformance

The identical bot suite (shared estimator + controller + SimPlayer, real
JWT auth) runs against either plane via a transport abstraction
(`sync-harness/src/bots/transport.ts`), gates included:

| plane | drift P50 | P95 | seq gaps | gate |
|---|---|---|---|---|
| node / Socket.IO / JSON | 73ms | 115ms | 0 | pass |
| relay-go / raw WS / binary | 75ms | 116ms | 0 | pass |

The control frame carries an optional idempotency key appended after the
room (`[cmdLen u8][cmdId...]`, ASCII `[A-Za-z0-9_-]{1,64}` — the same
charset the Node gateway enforces, so the derived Redis key cannot alias
another keyspace). Parsing is STRICT: a legacy frame must end exactly at
the room and a suffixed frame exactly at the cmdId — trailing bytes are a
malformed frame, rejected, because tolerating them lets two encoders
disagree about where a field ends and still both "work"
(`parseControl` in `main.go`, boundary cases in `main_test.go`). The relay
passes the key into the same `apply_control.lua`, so both planes dedup
identically — verified by the `--dup-controls` conformance run (4 injected
duplicates, 0 double-applies, on this plane's binary framing).

The relay does NOT speak `set-video` or the video fence
(`docs/SYNC_DESIGN.md` §2c): its binary control frame carries only
play/pause/seek, and its five-ARGV `apply_control.lua` calls leave the
fence flag absent — which the Lua reads as *unfenced*, the legacy
semantics old Node clients get too. Deliberate: the shared Lua evolves,
the relay's calls stay valid, and nothing on this plane changed when
set-video landed. Relay clients in a room whose video switches keep
following the timeline (the `videoId` field has always ridden every
broadcast); they just cannot initiate a switch.

*(10 bots × 120s each, re-measured after the simulated-player fix described
in `docs/SYNC_DESIGN.md` §8. **[lab]** — these two fleet runs were not
committed; the table is reproducible from the harness, not citable.)*

Same protocol, same convergence, cross-language — which is the point.

## Framing + runtime micro-benchmark (same machine, same Redis)

| | Socket.IO/JSON | raw-WS/binary |
|---|---|---|
| timeline broadcast wire size | 223 B | **31 B** (7.2×) |
| clock-ack RTT P50 **[lab]** | 0.23ms | **0.15ms** |
| clock-ack RTT P95 **[lab]** | 0.68ms | **0.38ms** |
| clock-ack RTT P99 **[lab]** | 1.38ms | **0.91ms** |

*The wire sizes are derived, not measured: 223 B is
`Buffer.byteLength('42' + JSON.stringify(['sync:timeline', timeline]))` for a
representative timeline and 31 B is the documented binary frame layout
(1+4+8+1+8+8+1), both computed in `bench-planes.ts` and checkable by reading
it. The RTT rows are **[lab]**: `bench-planes.ts` prints the percentiles and
writes no artifact.*

**Honest conclusion:** the binary plane is ~7× lighter on the wire and
~40% faster per exchange, but both planes sit deep under a millisecond on
loopback — **noise against the 30–300ms network RTTs that actually bound
sync quality**. Framing is not where watch-party drift lives; the relay's
real value is bandwidth at fanout scale and runtime headroom, and the
discipline of proving the protocol implementation-independent.

## Frame layout (little-endian)

| dir | type | payload |
|---|---|---|
| C→S | 0x01 ClockPing | `t0 f64` |
| S→C | 0x02 ClockPong | `t0 f64, t1 f64, t2 f64` |
| C→S | 0x03 Control | `intent u8, mediaTime f64, roomLen u8, room…[, cmdLen u8, cmdId…]` |
| S→C | 0x04 Timeline | `seq u32, epoch f64, isPlaying u8, mediaTime f64, stampedAt f64, reason u8` |
| C→S | 0x05 Join | `roomLen u8, room…` |
| S→C | 0x06 JoinAck | Timeline payload |
| S→C | 0x07 Rejected | `reason u8` |

Auth: the same JWT, via `?token=` at upgrade, with `exp` REQUIRED
(golang-jwt validates expiry only when present, so a token minted without
one never expired here) and a subject required, matching the Node socket
plane's refusal of subject-less tokens. Revocation: the relay reads the
backend's Redis mirror (`revoked:jti` set, `revoked:userver` hash) at
accept, subscribes to `mustard:revocations` to close affected connections
within a round trip, and a 30s sweep catches missed events and expired
tokens. Eviction closes the WEBSOCKET only — `c.send` is owned by the
handler's defer, and closing it from outside races `trySend` into a panic
that would take every room down with it. Room names get the same
separator-free charset as cmdId now: they are spliced into three Redis key
shapes, and a room containing `:` addressed someone else's keyspace.
Scope honesty: no Postgres —
any authenticated user may control (authorization was proven on the Node
plane; this plane measures transport and runtime); single instance,
in-process fanout; the 10s snapshot sweep runs with identical semantics.

## Run it

```bash
cd relay-go && go build ./...
JWT_SECRET=<same as backend> ./relay-go -redis redis://localhost:6380
cd ../sync-harness
npx tsx src/bots/run-bots.ts --n 10 --duration 120 --plane relay --ws http://localhost:3400 --gate
npx tsx src/bots/bench-planes.ts
```
