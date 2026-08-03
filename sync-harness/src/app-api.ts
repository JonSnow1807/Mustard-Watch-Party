// REST driver for test fixtures: ephemeral users and the scenario room.
// Base resolved lazily so runners can point it at a lab topology first.

function apiBase(): string {
  return process.env.HARNESS_API_URL ?? 'http://localhost:3000/api';
}

export interface HarnessUser {
  id: string;
  username: string;
  email: string;
  /** JWT for the socket handshake (issued at register/login) */
  token?: string;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function registerUser(runId: string, index: number): Promise<HarnessUser> {
  const username = `harness-${runId}-${index}`;
  const user = await post<HarnessUser>('/auth/register', {
    username,
    email: `${username}@harness.invalid`,
    password: `harness-${runId}`,
  });
  if (!user.id) throw new Error(`register returned no id: ${JSON.stringify(user)}`);
  return user;
}

export async function createRoom(
  creator: HarnessUser,
  runId: string,
  videoUrl: string,
): Promise<{ code: string; id: string }> {
  const room = await post<{ code: string; id: string }>('/rooms', {
    name: `harness ${runId}`,
    videoUrl,
    userId: creator.id,
    isPublic: false,
    allowGuestControl: false,
  });
  if (!room.code) throw new Error(`createRoom returned no code: ${JSON.stringify(room)}`);
  return room;
}

export async function backendHealthy(): Promise<boolean> {
  try {
    const res = await fetch((process.env.HARNESS_HEALTH_URL ?? 'http://localhost:3000') + '/health');
    return res.ok;
  } catch {
    return false;
  }
}
