// Minimal typed client for the Toxiproxy HTTP API (no packet-loss toxic
// exists at TCP level, which is why loss scenarios use the netem proxy).
// https://github.com/Shopify/toxiproxy#http-api

const API = process.env.TOXIPROXY_API ?? 'http://localhost:8474';

export const TOXIPROXY_LISTEN_PORT = 3101;

interface ToxicAttributes {
  latency?: number;
  jitter?: number;
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok && res.status !== 404 && res.status !== 409) {
    throw new Error(`toxiproxy ${init?.method ?? 'GET'} ${path}: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function toxiproxyUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/version`);
    return res.ok;
  } catch {
    return false;
  }
}

/** (Re)create the ws proxy: listen inside the container on 3101 -> backend. */
export async function resetProxy(upstream: string): Promise<void> {
  await api('/proxies/mustard-ws', { method: 'DELETE' });
  await api('/proxies', {
    method: 'POST',
    body: JSON.stringify({
      name: 'mustard-ws',
      listen: `0.0.0.0:${TOXIPROXY_LISTEN_PORT}`,
      upstream,
      enabled: true,
    }),
  });
}

async function addLatencyToxic(
  stream: 'upstream' | 'downstream',
  attributes: ToxicAttributes,
): Promise<void> {
  await api('/proxies/mustard-ws/toxics', {
    method: 'POST',
    body: JSON.stringify({
      name: `latency-${stream}`,
      type: 'latency',
      stream,
      toxicity: 1.0,
      attributes,
    }),
  });
}

export async function applyLatency(opts: {
  upLatencyMs?: number;
  downLatencyMs?: number;
  upJitterMs?: number;
  downJitterMs?: number;
}): Promise<void> {
  if (opts.upLatencyMs || opts.upJitterMs) {
    await addLatencyToxic('upstream', {
      latency: opts.upLatencyMs ?? 0,
      jitter: opts.upJitterMs ?? 0,
    });
  }
  if (opts.downLatencyMs || opts.downJitterMs) {
    await addLatencyToxic('downstream', {
      latency: opts.downLatencyMs ?? 0,
      jitter: opts.downJitterMs ?? 0,
    });
  }
}
