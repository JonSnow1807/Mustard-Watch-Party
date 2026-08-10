import axios from 'axios';

// Get API URL from environment or fallback to localhost
const getApiUrl = () => {
  return process.env.REACT_APP_API_URL || 'http://localhost:3000/api';
};

const API_URL = getApiUrl();

/**
 * Exported because the OAuth handoff is a full-page navigation, not an XHR:
 * the browser has to leave for Google and come back, so that one link needs
 * the absolute API origin rather than an axios instance.
 */
export const apiBaseUrl = API_URL;

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

const STORAGE_KEY = 'user';

/** Fired when the server rejects the stored token; nothing keeps a dead session. */
export const AUTH_EXPIRED_EVENT = 'mustard:auth-expired';

/**
 * The token the REST layer sends is the same one the socket handshake presents
 * ({ sub, name }, HS256) - one identity, two planes.
 *
 * Read per request, never cached at module load: signing in replaces the stored
 * user while this module is already evaluated, and a token captured once would
 * leave the whole tab authenticating as whoever was signed in at boot.
 */
const readStoredToken = (): string | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw);
    return typeof stored?.token === 'string' && stored.token ? stored.token : null;
  } catch {
    // unparseable storage is a signed-out tab, not a crashed one
    return null;
  }
};

const clearStoredUser = () => {
  localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
};

api.interceptors.request.use(config => {
  // Never attach to /auth/*: a token is meaningless to login/register, and
  // sending one there makes a bad-password 401 indistinguishable from an
  // expired-session 401 in the response interceptor below.
  if (config.url?.startsWith('/auth/')) return config;
  const token = readStoredToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    // Only a request that actually carried a token can have had it rejected.
    // A 401 from /auth/login is bad credentials, and clearing on that would
    // wipe a perfectly good session because someone fat-fingered a password.
    const sentToken = Boolean(error?.config?.headers?.Authorization);
    if (error?.response?.status === 401 && sentToken) {
      clearStoredUser();
    }
    return Promise.reject(error);
  },
);

// API methods
export const apiService = {
  // Auth
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }),

  register: (username: string, email: string, password: string) =>
    api.post('/auth/register', { username, email, password }),

  // Which sign-in methods this deployment can actually complete. Asked at
  // runtime rather than baked in at build: the frontend is one bundle served
  // to every environment, and a button for a provider the API has no
  // credentials for is a dead end.
  getProviders: () => api.get<{ google: boolean }>('/auth/providers'),

  // Exchange a bare token for the profile behind it - what the OAuth
  // callback lands with, since a redirect can carry a token but not a body.
  getMe: (token: string) =>
    api.get<{ id: string; username: string; email: string }>('/auth/me', {
      // explicit: the token being adopted is not the stored one yet, and the
      // request interceptor can only ever attach what is already stored
      headers: { Authorization: `Bearer ${token}` },
    }),

  // Rooms
  // No userId anywhere below: the server reads the caller off the bearer token,
  // and a client-supplied id would only be a suggestion it ignores.
  createRoom: (data: {
    name: string;
    videoUrl?: string;
    isPublic?: boolean;
    description?: string;
    tags?: string[];
    allowGuestControl?: boolean;
  }) => api.post('/rooms', data),

  getRoomByCode: (code: string) =>
    api.get(`/rooms/${code}`),

  // Every field here is one the server's UpdateRoomDto actually accepts.
  // allowGuestControl used to be listed and silently stripped by the pipe's
  // whitelist, so the settings form appeared to save it and never did.
  updateRoom: (code: string, data: {
    name?: string;
    videoUrl?: string;
    isPublic?: boolean;
    allowGuestControl?: boolean;
    maxUsers?: number;
  }) => api.patch(`/rooms/${code}`, data),

  deleteRoom: (code: string) =>
    api.delete(`/rooms/${code}`),

  getUserRooms: () =>
    api.get('/rooms/mine'),

  getPublicRooms: (filter?: string) =>
    api.get('/rooms/public', { params: { filter } }),
};

export { api };
