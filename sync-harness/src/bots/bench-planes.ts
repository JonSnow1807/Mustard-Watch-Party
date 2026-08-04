// Plane micro-benchmark: clock-exchange RTT distribution + wire sizes,
// Node/Socket.IO/JSON vs relay-go/raw-WS/binary — same machine, same Redis,
// same Lua. This measures framing + runtime overhead, nothing else.
//   npx tsx src/bots/bench-planes.ts
import { registerUser } from '../app-api.js';
import { percentile } from '../stats.js';
import { RawWSBinaryTransport, SocketIOTransport, type SyncTransport } from './transport.js';

const PINGS = 2000;
const GAP_MS = 2;

async function bench(name: string, transport: SyncTransport, token: string): Promise<void> {
  await transport.connect(token);
  const rtts: number[] = [];
  let timedOut = 0;
  for (let i = 0; i < PINGS; i++) {
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      let settled = false;
      const timer = setTimeout(() => {
        // the callback stays registered on the transport; without this guard
        // a late pong would append a bogus RTT AND (on the raw-WS plane,
        // where pongs are matched FIFO) shift every later measurement
        settled = true;
        timedOut += 1;
        resolve();
      }, 1000);
      transport.sendClock(Date.now(), () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rtts.push(performance.now() - t0);
        resolve();
      });
    });
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  transport.disconnect();
  const sorted = [...rtts].sort((a, b) => a - b);
  console.log(
    `${name}: n=${sorted.length}${timedOut ? ` (${timedOut} timed out)` : ''} ` +
      `P50=${percentile(sorted, 50).toFixed(2)}ms ` +
      `P95=${percentile(sorted, 95).toFixed(2)}ms ` +
      `P99=${percentile(sorted, 99).toFixed(2)}ms`,
  );
}

const user = await registerUser(`bench-${Date.now().toString(36)}`, 0);

// wire sizes for one timeline broadcast
const sampleTimeline = {
  v: 1, seq: 42, storeEpoch: String(Date.now()), videoId: 'aqz-KE-bpKQ',
  isPlaying: true, mediaTime: 1234.5678, stampedAt: Date.now(), rate: 1,
  reason: 'seek', by: '662f9847-dba5-4741-a36b-252278b6def3',
};
// socket.io frame: '42["sync:timeline",{...}]' (engine.io type 4 + socket.io type 2)
const sioBytes = Buffer.byteLength(`42${JSON.stringify(['sync:timeline', sampleTimeline])}`);
console.log(`timeline broadcast wire size: socket.io/JSON=${sioBytes}B binary=31B (${(sioBytes / 31).toFixed(1)}x)`);

await bench('node/socket.io', new SocketIOTransport('http://localhost:3000'), user.token ?? '');
await bench('relay-go/binary', new RawWSBinaryTransport('http://localhost:3400'), user.token ?? '');
process.exit(0);
