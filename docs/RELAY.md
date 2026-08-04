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

*(10 bots × 120s each, re-measured after the simulated-player fix described
in `docs/SYNC_DESIGN.md` §8.)*

Same protocol, same convergence, cross-language — which is the point.

## Framing + runtime micro-benchmark (same machine, same Redis)

| | Socket.IO/JSON | raw-WS/binary |
|---|---|---|
| timeline broadcast wire size | 223 B | **31 B** (7.2×) |
| clock-ack RTT P50 | 0.23ms | **0.15ms** |
| clock-ack RTT P95 | 0.68ms | **0.38ms** |
| clock-ack RTT P99 | 1.38ms | **0.91ms** |

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
| C→S | 0x03 Control | `intent u8, mediaTime f64, roomLen u8, room…` |
| S→C | 0x04 Timeline | `seq u32, epoch f64, isPlaying u8, mediaTime f64, stampedAt f64, reason u8` |
| C→S | 0x05 Join | `roomLen u8, room…` |
| S→C | 0x06 JoinAck | Timeline payload |
| S→C | 0x07 Rejected | `reason u8` |

Auth: the same JWT, via `?token=` at upgrade. Scope honesty: no Postgres —
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
