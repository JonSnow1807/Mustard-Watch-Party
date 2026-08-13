import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import { AUTH_EXPIRED_EVENT, apiService } from '../services/api';
import { clearRecentRooms } from '../services/recent-rooms';

interface User {
  id: string;
  username: string;
  email: string;
  /** JWT presented in the socket handshake; verified server-side at connect */
  token?: string;
}

interface AuthContextType {
  user: User | null;
  /**
   * Has the stored session been read yet?
   *
   * `user` is null for the first render of every page load, including for
   * someone perfectly well signed in, because the session is rehydrated in an
   * effect. Any page that redirects on `!user` therefore redirected everyone
   * - opening or reloading a room bounced you to the join page and made you
   * click through again. Guard those redirects on this instead.
   */
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  /** Adopt a token minted elsewhere - today, by the Google callback. */
  signInWithToken: (token: string) => Promise<void>;
  /**
   * Turn the guest session you are already in into a real account, keeping
   * the same row - so chat you have already sent stays attributed to you.
   */
  claimAccount: (
    username: string,
    email: string,
    password: string,
  ) => Promise<void>;
  /** Sign in with no account at all; see docs/GUEST_ACCESS.md. */
  continueAsGuest: () => Promise<void>;
  /** True when this session has no password and no provider behind it. */
  isGuest: boolean;
  /**
   * Sign out. `everywhere` revokes every session this account has rather
   * than just this one - the answer to a token that may have leaked.
   */
  logout: (options?: { everywhere?: boolean }) => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // Check for stored user on mount. Wrapped: a corrupt entry (a half-written
  // value, a schema change) would otherwise throw during render and leave a
  // blank page instead of a signed-out one.
  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      try {
        setUser(JSON.parse(storedUser));
      } catch {
        localStorage.removeItem('user');
      }
    }
    // set last and unconditionally: consumers wait on this to know that
    // `user === null` means signed out rather than not-read-yet
    setReady(true);
  }, []);

  // The API layer clears storage and fires this when a request comes back 401
  // with a token attached - i.e. the token expired or was revoked mid-session.
  // Without a listener the UI kept rendering as signed-in against a dead
  // token, and every action failed silently.
  useEffect(() => {
    const onExpired = () => {
      setUser(null);
      // the same reasoning as logout: a dead session must not leave the next
      // person a list of where the last one had been
      clearRecentRooms();
      toast.error('Session expired - sign in again');
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    try {
      const response = await axios.post(`${API_URL}/auth/login`, {
        username,
        password,
      });
      
      const userData = response.data;
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));
      toast.success('Signed in');
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Couldn't sign in");
      throw error;
    }
  }, []);

  const register = useCallback(async (username: string, email: string, password: string) => {
    try {
      const response = await axios.post(`${API_URL}/auth/register`, {
        username,
        email,
        password,
      });
      
      const userData = response.data;
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));
      toast.success('Account created');
    } catch (error: any) {
      toast.error(error.response?.data?.message || "Couldn't create the account");
      throw error;
    }
  }, []);

  /**
   * The OAuth callback arrives holding a token and nothing else - a redirect
   * can carry a fragment but not a response body - so the profile is fetched
   * with the token before anything is stored. That fetch is also the
   * verification: a token the API will not answer for never becomes a
   * session, so a hand-typed fragment cannot fake one into the UI.
   */
  const signInWithToken = useCallback(async (token: string) => {
    try {
      const { data } = await apiService.getMe(token);
      const userData: User = { ...data, token };
      setUser(userData);
      localStorage.setItem('user', JSON.stringify(userData));
      toast.success('Signed in');
    } catch (error: any) {
      toast.error("Couldn't complete sign-in");
      throw error;
    }
  }, []);

  const continueAsGuest = useCallback(async () => {
    try {
      const { data } = await apiService.guest();
      setUser(data);
      localStorage.setItem('user', JSON.stringify(data));
      toast.success(`You are in as ${data.username}`);
    } catch (error: any) {
      toast.error(
        error?.response?.status === 429
          ? 'Too many guests from this connection - try again shortly'
          : "Couldn't join as a guest",
      );
      throw error;
    }
  }, []);

  /**
   * Keep the session fresh without keeping it forever.
   *
   * Scheduled at ~90% of the token's remaining life (decoded locally - the
   * expiry is not a secret, and mis-decoding only means a missed refresh,
   * which the hard expiry already handles). On success the server has
   * REVOKED the old token, so the update below is not cosmetic: the copy
   * that refreshed is the only copy still alive. On refusal - revoked
   * elsewhere, session past its thirty-day cap - nothing happens here;
   * the existing expiry machinery (401 handling, socket eviction) ends
   * the session the way it already knows how.
   *
   * The socket reconnects when the token changes (its effect keys on
   * [token]); once per ~11 hours, that brief rejoin is the price of not
   * being signed out mid-film at hour twelve.
   */
  useEffect(() => {
    const token = user?.token;
    if (!token) return;
    let expMs: number | null = null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1])) as {
        exp?: number;
        elev?: string;
      };
      // elevated tokens are five-minute instruments, never sessions
      if (payload.elev) return;
      if (typeof payload.exp === 'number') expMs = payload.exp * 1000;
    } catch {
      return; // undecodable: let the server be the judge at next request
    }
    if (expMs === null) return;
    const delay = Math.max((expMs - Date.now()) * 0.9, 60_000);
    const timer = setTimeout(() => {
      apiService
        .refresh()
        .then(({ data }) => {
          setUser((current) =>
            current ? { ...current, token: data.token } : current,
          );
          const stored = localStorage.getItem('user');
          if (stored) {
            localStorage.setItem(
              'user',
              JSON.stringify({
                ...(JSON.parse(stored) as object),
                token: data.token,
              }),
            );
          }
        })
        .catch(() => undefined);
    }, delay);
    return () => clearTimeout(timer);
  }, [user?.token]);

  const claimAccount = useCallback(
    async (username: string, email: string, password: string) => {
      try {
        const { data } = await apiService.claim(username, email, password);
        // The server issues a fresh token here: the old one carries the
        // guest name, which is about to be wrong everywhere it is shown.
        setUser(data);
        localStorage.setItem('user', JSON.stringify(data));
        toast.success(`Welcome properly, ${data.username}`);
      } catch (error: any) {
        const status = error?.response?.status;
        toast.error(
          // The server's message is the useful one for 400/409 - it says
          // which rule was broken - and a generic string would hide it.
          status === 400 || status === 409
            ? error?.response?.data?.message || "That didn't work"
            : status === 403
              ? 'This session is already a full account'
              : "Couldn't save your account",
        );
        throw error;
      }
    },
    [],
  );

  /**
   * Drop the local session, and tell the server to stop trusting the token.
   *
   * The local half happens FIRST and unconditionally. Signing out is not
   * allowed to fail: if the network is down, the person in front of the
   * screen still wants to be signed out of this machine, and leaving them
   * signed in because a request failed would be the worst possible reading
   * of "sign out".
   *
   * The server half is what makes it real - without it a copy of the token
   * keeps working for the rest of its life - but it is best-effort, and the
   * token expires on its own regardless.
   */
  const logout = useCallback((options?: { everywhere?: boolean }) => {
    const revoke = options?.everywhere
      ? apiService.logoutEverywhere()
      : apiService.logout();
    revoke.catch(() => undefined);

    setUser(null);
    localStorage.removeItem('user');
    // where you have been is as personal as who you are, and this machine
    // may not be yours
    clearRecentRooms();
    toast.success(
      options?.everywhere ? 'Signed out everywhere' : 'Signed out',
    );
  }, []);

  const value: AuthContextType = {
    user,
    ready,
    login,
    register,
    signInWithToken,
    continueAsGuest,
    claimAccount,
    // the synthetic address the server mints is the only marker the client
    // gets, and it is one no real account can have: .invalid is reserved
    isGuest: Boolean(user?.email?.endsWith('@guest.invalid')),
    logout,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};