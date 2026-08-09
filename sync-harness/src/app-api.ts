// REST driver for test fixtures: ephemeral users and the scenario room.
// Base resolved lazily so runners can point it at a lab topology first.

function apiBase(): string {
  return process.env.HARNESS_API_URL ?? 'http://localhost:3000/api';
}

export interface HarnessUser {
  id: string;
  username: string;
  email: string;
  /**
   * JWT proving this identity. One token, two planes: the socket handshake
   * (sync/ws-auth.ts) and now every REST call too. The server derives the
   * actor from this token — the harness no longer *tells* it who it is.
   */
  token: string;
}

/** Bearer header for the REST plane; omitted entirely when no token. */
function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function post<T>(path: string, body: unknown, token?: string): Promise<T> {
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(token) },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`POST ${path}: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}


export async function registerUser(runId: string, index: number): Promise<HarnessUser> {
  const username = `harness-${runId}-${index}`;
  // register mints the token; it is the one endpoint that cannot require one
  const user = await post<HarnessUser>('/auth/register', {
    username,
    email: `${username}@harness.invalid`,
    password: `harness-${runId}`,
  });
  if (!user.id) throw new Error(`register returned no id: ${JSON.stringify(user)}`);
  // Every downstream call — REST and socket — is authenticated with this
  // token, so a tokenless registration has to fail HERE. Otherwise it
  // surfaces later as an unexplained 401 from whatever ran next.
  if (!user.token) throw new Error(`register returned no token: ${JSON.stringify(user)}`);
  return user;
}

export async function createRoom(
  creator: HarnessUser,
  runId: string,
  videoUrl: string,
): Promise<{ code: string; id: string }> {
  if (!creator.token) {
    throw new Error(`createRoom needs ${creator.username}'s token: POST /rooms is authenticated`);
  }
  // No userId in the body: ownership comes from the bearer token. Sending a
  // creator id here would be exactly the forgeable claim the guard removes.
  const room = await post<{ code: string; id: string }>(
    '/rooms',
    {
      name: `harness ${runId}`,
      videoUrl,
      isPublic: false,
      allowGuestControl: false,
    },
    creator.token,
  );
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
