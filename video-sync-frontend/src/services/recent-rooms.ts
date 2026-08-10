/**
 * The rooms you were just in.
 *
 * A room you joined by link belongs to nobody's dashboard: "Your rooms"
 * lists what you CREATED, and a private room you were invited to appears in
 * no listing at all. Close the tab and the only way back is to find the
 * original message again. This remembers the last few, locally.
 *
 * Local on purpose: it is a convenience, not a membership record, and the
 * server already knows who joined what. Keeping it in localStorage means no
 * new endpoint, no new column, and nothing to leak from one account to the
 * next beyond room names on a shared machine - which the sign-out path
 * clears for exactly that reason.
 */
const KEY = 'mustard:recent-rooms';
const LIMIT = 6;

export interface RecentRoom {
  code: string;
  name: string;
  /** ms epoch of the last visit, for ordering and "2h ago" */
  at: number;
}

const isRecord = (v: unknown): v is RecentRoom => {
  const r = v as RecentRoom | null;
  return (
    !!r &&
    typeof r.code === 'string' &&
    r.code.length > 0 &&
    typeof r.name === 'string' &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at)
  );
};

export const listRecentRooms = (): RecentRoom[] => {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filter rather than trust: this survives a schema change and a
    // half-written value, and a corrupt entry must not blank the dashboard.
    return parsed.filter(isRecord).sort((a, b) => b.at - a.at).slice(0, LIMIT);
  } catch {
    return [];
  }
};

/** Record a visit. The newest wins, and a room is never listed twice. */
export const rememberRoom = (
  room: { code: string; name: string },
  now: number = Date.now(),
): void => {
  if (!room?.code) return;
  try {
    const next = [
      { code: room.code, name: room.name || room.code, at: now },
      ...listRecentRooms().filter((r) => r.code !== room.code),
    ].slice(0, LIMIT);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // a full or disabled localStorage is not worth failing a page load over
  }
};

export const forgetRoom = (code: string): void => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify(listRecentRooms().filter((r) => r.code !== code)),
    );
  } catch {
    /* see above */
  }
};

/** Signing out must not leave the next person a list of where you have been. */
export const clearRecentRooms = (): void => {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* see above */
  }
};
