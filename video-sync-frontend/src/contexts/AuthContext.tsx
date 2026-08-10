import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { toast } from 'react-hot-toast';
import { AUTH_EXPIRED_EVENT, apiService } from '../services/api';

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
  logout: () => void;
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

  const logout = useCallback(() => {
    setUser(null);
    localStorage.removeItem('user');
    toast.success('Signed out');
  }, []);

  const value: AuthContextType = {
    user,
    ready,
    login,
    register,
    signInWithToken,
    logout,
    isAuthenticated: !!user,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};