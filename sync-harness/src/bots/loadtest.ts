// A LOAD harness, not a sync harness. The bot fleet answers "do clients stay
// in sync"; this answers "what does the server cost per connection, and what
// happens to tail latency under many of them" - the regime where Node, Go,
// and Rust actually diverge, and the one the drift measurements deliberately
// did not touch (drift is bounded by protocol+network, not the runtime).
//
// It is deliberately thin: one raw WebSocket per simulated client, holding the
// connection and sending a clock ping every second, measuring the ping->pong
// RTT distribution and (separately, via `ps`) the server's RSS and CPU. A full
// SimPlayer per client would make the CLIENT the bottleneck long before the
// server, so none runs here.
//
// HONESTY: client and server are co-resident on one machine. Absolute numbers
// are a conservative floor - the client competes for the same cores. The
// comparison BETWEEN planes is fair: same machine, same client, same instant,
// only the server binary changes. Read the relative columns, not the absolute.
//
// Usage:
//   tsx src/bots/loadtest.ts --n 1000 --ws http://localhost:3510 \
//       --plane relay --api http://localhost:3000/api --server-pid <pid> \
//       --hold 30 --label rust-1k
import WebSocket from 'ws';
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

interface Args {
  n: number;
  wsUrl: string;
  apiUrl: string;
  plane: 'relay' | 'node';
  serverPid: number | null;
  holdS: number;
  label: string;
}

const parse = (): Args => {
  const get = (f: string): string | undefined => {
    const i = process.argv.indexOf(f);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  return {
    n: parseInt(get('--n') ?? '1000', 10),
    wsUrl: get('--ws') ?? 'http://localhost:3510',
    apiUrl: get('--api') ?? 'http://localhost:3000/api',
    plane: (get('--plane') ?? 'relay') as 'relay' | 'node',
    serverPid: get('--server-pid') ? parseInt(get('--server-pid')!, 10) : null,
    holdS: parseInt(get('--hold') ?? '30', 10),
    label: get('--label') ?? 'run',
  };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One token from the Node backend; every simulated client reuses it - the
 *  server derives identity from the token, and we are measuring the transport
 *  and connection cost, not per-user state. */
const mintToken = async (apiUrl: string): Promise<string> => {
  const r = await fetch(`${apiUrl}/auth/guest`, { method: 'POST' });
  const body = (await r.json()) as { token?: string };
  if (!body.token) throw new Error(`no token from ${apiUrl}/auth/guest`);
  return body.token;
};

/** RSS (KB) and cumulative CPU seconds for a pid, via ps - portable on macOS. */
const sample = (pid: number): { rssKb: number; cpuPct: number } => {
  const out = execSync(`ps -o rss=,%cpu= -p ${pid}`).toString().trim();
  const [rss, cpu] = out.split(/\s+/).map(Number);
  return { rssKb: rss || 0, cpuPct: cpu || 0 };
};

const percentile = (sorted: number[], p: number): number => {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
};

// a clock ping frame: [0x01][8 bytes echo]. The echo is a monotonic id we can
// match the pong to. relay planes reply 0x02 [echo][t1][t2]; the Node plane is
// socket.io and not raw-WS, so this harness targets the raw-WS planes (relay-go
// and relay-rs) where the binary protocol is identical. Node is measured by
// the existing bot fleet, which is the fair socket.io comparison.
const pingFrame = (id: number): Buffer => {
  const b = Buffer.alloc(9);
  b.writeUInt8(0x01, 0);
  b.writeDoubleLE(id, 1);
  return b;
};

async function main() {
  const args = parse();
  const token = await mintToken(args.apiUrl);
  const wsBase = args.wsUrl.replace(/^http/, 'ws');

  const sockets: WebSocket[] = [];
  const rtts: number[] = [];
  const pending = new Map<number, number>(); // echo id -> send time
  let nextId = 1;
  let connectErrors = 0;
  let connected = 0;

  const baseline = args.serverPid ? sample(args.serverPid) : null;

  // Open N connections, paced so the accept path is exercised without a
  // thundering-herd artifact that measures the OS backlog rather than the
  // server. 50 opens per 10ms = 5k/s, comfortably below either server's cap.
  const openStart = Date.now();
  for (let i = 0; i < args.n; i++) {
    const ws = new WebSocket(`${wsBase}/sync?token=${token}`, {
      perMessageDeflate: false,
    });
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => {
      connected++;
    });
    ws.on('message', (data: Buffer) => {
      if (data.length >= 9 && data.readUInt8(0) === 0x02) {
        const id = data.readDoubleLE(1);
        const sent = pending.get(id);
        if (sent !== undefined) {
          rtts.push(Date.now() - sent);
          pending.delete(id);
        }
      }
    });
    ws.on('error', () => {
      connectErrors++;
    });
    sockets.push(ws);
    if (i % 50 === 49) await sleep(10);
  }

  // wait for the fleet to finish connecting (or give up after a bound)
  for (let w = 0; w < 200 && connected + connectErrors < args.n; w++) {
    await sleep(100);
  }
  const acceptMs = Date.now() - openStart;

  // steady state: every live socket pings once a second for holdS seconds.
  // This is the load under which tail latency (and GC pauses, if any) show up.
  const pingTimer = setInterval(() => {
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        const id = nextId++;
        pending.set(id, Date.now());
        ws.send(pingFrame(id));
      }
    }
  }, 1000);

  // sample the server mid-hold, when all connections are established and the
  // ping load is steady - the honest "cost at N connections" moment.
  await sleep((args.holdS / 2) * 1000);
  const mid = args.serverPid ? sample(args.serverPid) : null;
  await sleep((args.holdS / 2) * 1000);

  clearInterval(pingTimer);
  for (const ws of sockets) ws.terminate();

  rtts.sort((a, b) => a - b);
  const rssPerConnKb =
    baseline && mid && connected > 0
      ? (mid.rssKb - baseline.rssKb) / connected
      : null;

  const result = {
    label: args.label,
    plane: args.plane,
    ws: args.wsUrl,
    requested: args.n,
    connected,
    connectErrors,
    acceptMs,
    acceptPerSec: connected > 0 ? Math.round((connected / acceptMs) * 1000) : 0,
    pings: rtts.length,
    rttP50: percentile(rtts, 50),
    rttP95: percentile(rtts, 95),
    rttP99: percentile(rtts, 99),
    rttP999: percentile(rtts, 99.9),
    rttMax: rtts.length ? rtts[rtts.length - 1] : NaN,
    server: {
      baselineRssKb: baseline?.rssKb ?? null,
      loadedRssKb: mid?.rssKb ?? null,
      rssPerConnKb: rssPerConnKb !== null ? Math.round(rssPerConnKb * 10) / 10 : null,
      cpuPctUnderLoad: mid?.cpuPct ?? null,
    },
    gitSha: gitSha(),
    hardware: hardware(),
    at: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));
  mkdirSync('runs', { recursive: true });
  writeFileSync(`runs/loadtest-${args.label}.json`, JSON.stringify(result, null, 2));
}

function gitSha(): string {
  try {
    const sha = execSync('git rev-parse HEAD').toString().trim();
    const dirty = execSync('git status --porcelain').toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

function hardware(): string {
  try {
    const cores = execSync('sysctl -n hw.ncpu').toString().trim();
    const mem = execSync('sysctl -n hw.memsize').toString().trim();
    return `${cores} cores, ${Math.round(Number(mem) / 1e9)}GB`;
  } catch {
    return 'unknown';
  }
}

void main();
