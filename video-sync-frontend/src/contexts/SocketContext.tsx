import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'react-hot-toast';
import { useAuth } from './AuthContext';

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
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
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    socketInstance.on('connect', () => {
      console.log('Connected to server');
      setConnected(true);
      toast.success('Connected to sync server');
    });

    socketInstance.on('disconnect', () => {
      console.log('Disconnected from server');
      setConnected(false);
      toast.error('Disconnected from sync server');
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
    <SocketContext.Provider value={{ socket, connected }}>
      {children}
    </SocketContext.Provider>
  );
};
