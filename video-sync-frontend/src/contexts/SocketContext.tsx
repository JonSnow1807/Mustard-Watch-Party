import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'react-hot-toast';
import { useAuth } from './AuthContext';
import { AUTH_EXPIRED_EVENT } from '../services/api';
import { dropStaleControls } from '../sync/drop-stale-controls';

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
  /**
   * Dropped, but socket.io is still trying. Distinct from `!connected`,
   * which is also true for the first moment of a page load - and a room that
   * says "Disconnected" before it has ever connected reads as broken.
   */
  reconnecting: boolean;
}

const SocketContext = createContext<SocketContextType | null>(null);

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within SocketProvider');
  }
  return context;
};

interface SocketProviderProps {
  children: React.ReactNode;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children }) => {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const token = user?.token;
  /**
   * Did the SERVER end this session on purpose?
   *
   * A ref rather than state: it is read inside the socket handlers, which
   * close over the value at the time the effect ran, and a stale `false`
   * there would put the UI back into "reconnecting" for a session that can
   * never come back.
   */
  const endedRef = useRef(false);

  useEffect(() => {
    endedRef.current = false;
    // the gateway rejects unauthenticated sockets; without a token there is
    // nothing to connect (login/register issue one)
    if (!token) {
      setSocket(null);
      setConnected(false);
      return;
    }

    // Harness override: ?ws=<url> routes the socket through an impairment
    // proxy during measurement runs; inert unless the query param is present.
    const wsOverride = new URLSearchParams(window.location.search).get('ws');
    const wsUrl =
      wsOverride || process.env.REACT_APP_WS_URL || 'ws://localhost:3000';
    console.log('Connecting to WebSocket server:', wsUrl);

    const socketInstance = io(wsUrl, {
      transports: ['websocket', 'polling'],
      auth: { token },
      reconnection: true,
      // never give up: a >30s outage used to permanently kill the session
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
    });

    // A fresh socket starts with a clean slate: the previous session's
    // teardown fires 'disconnect', which would otherwise leave this true
    // and make the NEXT session's first connection read as a reconnect.
    setReconnecting(false);

    // The first connect is not news - it is the page loading, and it used to
    // fire a success toast on top of "Joined the room" every single time.
    // A RE-connect is news: it says the gap you just noticed is over.
    let hasConnected = false;

    socketInstance.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
      setReconnecting(false);
      if (hasConnected) toast.success('Back in sync');
      hasConnected = true;
    });

    // The server closed this connection on purpose - the token behind it was
    // signed out or expired. Without this, socket.io would reconnect forever
    // with the same dead token and the person would see an unexplained
    // "reconnecting" chip that never resolves.
    socketInstance.on(
      'session-ended',
      ({ reason }: { reason?: string } = {}) => {
        endedRef.current = true;
        // Stop the retry loop before it starts; the token cannot come back.
        socketInstance.disconnect();
        toast.error(
          reason === 'token expired'
            ? 'Your session expired - sign in again'
            : reason === 'signed out everywhere'
              ? 'You were signed out everywhere'
              : 'This session was signed out',
        );
        window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
      },
    );

    socketInstance.on('disconnect', () => {
      console.log('Disconnected from server');
      // Enforce the no-buffering contract the dedup TTL's soundness rests
      // on (docs/SYNC_DESIGN.md, formal/SyncExactlyOnce.tla RetryWindow):
      // an emit that raced a dying transport - connected still true, socket
      // half-open - sits in socket.io's sendBuffer, and socket.io flushes
      // that buffer on reconnect BEFORE app-level connect handlers run, so
      // clearing on reconnect is too late. Filtered here, at the moment the
      // death is detected: a stale CONTROL is dropped instead of arriving
      // arbitrarily late (a dropped gesture stays dropped; the user clicks
      // again), while everything else - a chat message someone typed, whose
      // input was already cleared and which has no recovery path - keeps
      // its place and flushes on reconnect like it should. The first
      // version of this cleared the whole buffer and would have eaten
      // exactly those chat messages.
      socketInstance.sendBuffer = dropStaleControls(socketInstance.sendBuffer);
      setConnected(false);
      // Only claim to be reconnecting once there is something to reconnect
      // TO. No toast: socket.io retries by itself, the status chip carries
      // it, and a red toast on every brief blip trains people to ignore
      // toasts entirely.
      // A session that ENDED is not a session that is reconnecting. Saying
      // "reconnecting" here would promise something that cannot happen.
      setReconnecting(hasConnected && !endedRef.current);
    });

    socketInstance.on('connect_error', (error: Error) => {
      console.error('Socket connect error:', error.message);
    });

    socketInstance.on('error', (error: any) => {
      console.error('Socket error:', error);
      toast.error(error.message || 'Connection error');
    });

    setSocket(socketInstance);

    return () => {
      // stop the teardown's own disconnect from being mistaken for a drop
      hasConnected = false;
      socketInstance.disconnect();
      setReconnecting(false);
    };
  }, [token]);

  return (
    <SocketContext.Provider value={{ socket, connected, reconnecting }}>
      {children}
    </SocketContext.Provider>
  );
};
