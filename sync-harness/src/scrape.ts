// Minimal Prometheus text-format scraper: polls each instance's /metrics
// during a sweep cell and keeps the series needed to attribute the knee.

export interface MetricSample {
  t: number;
  instance: string;
  eventLoopLagP99S: number | null;
  processCpuSeconds: number | null;
  rssBytes: number | null;
  connectedClients: number | null;
}

function parseLine(text: string, name: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const m = line.match(/^([a-z0-9_]+)(\{[^}]*\})?\s+([-0-9.e+]+)$/i);
    if (m && m[1] === name) out.set(m[2] ?? '', Number(m[3]));
  }
  return out;
}

export class Scraper {
  private samples: MetricSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private targets: Array<{ instance: string; url: string }>) {}

  start(intervalMs = 5000): void {
    const poll = async (): Promise<void> => {
      const t = Date.now();
      await Promise.all(
        this.targets.map(async ({ instance, url }) => {
          try {
            const res = await fetch(`${url}/metrics`, { signal: AbortSignal.timeout(4000) });
            const text = await res.text();
            const lag = parseLine(text, 'nodejs_eventloop_lag_p99_seconds');
            const cpu = parseLine(text, 'process_cpu_seconds_total');
            const rss = parseLine(text, 'process_resident_memory_bytes');
            const conn = parseLine(text, 'ws_connected_clients');
            const first = (m: Map<string, number>): number | null =>
              m.size > 0 ? [...m.values()][0] : null;
            const connTotal =
              conn.size > 0 ? [...conn.values()].reduce((s, x) => s + x, 0) : null;
            this.samples.push({
              t,
              instance,
              eventLoopLagP99S: first(lag),
              processCpuSeconds: first(cpu),
              rssBytes: first(rss),
              connectedClients: connTotal,
            });
          } catch {
            // instance briefly unreachable; the gap itself is informative
          }
        }),
      );
    };
    void poll();
    this.timer = setInterval(() => void poll(), intervalMs);
  }

  stop(): MetricSample[] {
    if (this.timer) clearInterval(this.timer);
    return this.samples;
  }
}

/** Per-instance summary over the measurement window. */
export function summarize(samples: MetricSample[]): Record<
  string,
  { lagP99MaxMs: number; cpuCoresAvg: number; rssMaxMb: number; clientsMax: number }
> {
  const byInstance = new Map<string, MetricSample[]>();
  for (const s of samples) {
    const arr = byInstance.get(s.instance) ?? [];
    arr.push(s);
    byInstance.set(s.instance, arr);
  }
  const out: Record<
    string,
    { lagP99MaxMs: number; cpuCoresAvg: number; rssMaxMb: number; clientsMax: number }
  > = {};
  for (const [instance, arr] of byInstance) {
    arr.sort((a, b) => a.t - b.t);
    const lags = arr.map((x) => x.eventLoopLagP99S ?? 0);
    const first = arr[0];
    const last = arr[arr.length - 1];
    const cpuCores =
      first.processCpuSeconds !== null && last.processCpuSeconds !== null && last.t > first.t
        ? (last.processCpuSeconds - first.processCpuSeconds) / ((last.t - first.t) / 1000)
        : 0;
    out[instance] = {
      lagP99MaxMs: Math.max(...lags, 0) * 1000,
      cpuCoresAvg: cpuCores,
      rssMaxMb: Math.max(...arr.map((x) => x.rssBytes ?? 0)) / 1e6,
      clientsMax: Math.max(...arr.map((x) => x.connectedClients ?? 0)),
    };
  }
  return out;
}
