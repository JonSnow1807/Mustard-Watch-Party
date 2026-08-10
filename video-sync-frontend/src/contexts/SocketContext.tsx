import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'react-hot-toast';
import { useAuth } from './AuthContext';

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

  useEffect(() => {
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

    socketInstance.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
      // Only claim to be reconnecting once there is something to reconnect
      // TO. No toast: socket.io retries by itself, the status chip carries
      // it, and a red toast on every brief blip trains people to ignore
      // toasts entirely.
      setReconnecting(hasConnected);
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
      socketInstance.disconnect();
    };
  }, [token]);

  return (
    <SocketContext.Provider value={{ socket, connected, reconnecting }}>
      {children}
    </SocketContext.Provider>
  );
};
