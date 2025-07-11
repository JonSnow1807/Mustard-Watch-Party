import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { toast } from 'react-hot-toast';

interface VideoState {
  currentTime: number;
  isPlaying: boolean;
}

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
  joinRoom: (roomCode: string, userId: string) => void;
  leaveRoom: () => void;
  sendVideoAction: (action: 'play' | 'pause' | 'seek', currentTime: number) => void;
  currentRoom: string | null;
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
  serverUrl: string;
}

export const SocketProvider: React.FC<SocketProviderProps> = ({ children, serverUrl }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [currentRoom, setCurrentRoom] = useState<string | null>(null);

  useEffect(() => {
    console.log('Connecting to WebSocket server:', serverUrl);
    
    const socketInstance = io(serverUrl, {
      transports: ['websocket', 'polling'],
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

    socketInstance.on('error', (error: any) => {
      console.error('Socket error:', error);
      toast.error(error.message || 'Connection error');
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, [serverUrl]);

  const joinRoom = useCallback((roomCode: string, userId: string) => {
    if (socket && connected) {
      console.log('Joining room:', roomCode);
      socket.emit('join-room', { roomCode, userId });
      setCurrentRoom(roomCode);
    }
  }, [socket, connected]);

  const leaveRoom = useCallback(() => {
    if (socket && currentRoom) {
      socket.emit('leave-room', { roomCode: currentRoom });
      setCurrentRoom(null);
    }
  }, [socket, currentRoom]);

  const sendVideoAction = useCallback((action: 'play' | 'pause' | 'seek', currentTime: number) => {
    if (socket && currentRoom) {
      socket.emit('video-action', {
        roomCode: currentRoom,
        action,
        currentTime,
      });
    }
  }, [socket, currentRoom]);

  const value: SocketContextType = {
    socket,
    connected,
    joinRoom,
    leaveRoom,
    sendVideoAction,
    currentRoom,
  };

  return (
    <SocketContext.Provider value={value}>
      {children}
    </SocketContext.Provider>
  );
};