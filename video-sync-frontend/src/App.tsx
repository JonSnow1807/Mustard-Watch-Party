import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { SocketProvider } from './contexts/SocketContext';
import { AuthProvider } from './contexts/AuthContext';
import { HomePage } from './pages/HomePage';
import { RoomPage } from './pages/RoomPage';
import { LoginPage } from './pages/LoginPage';
import { CreateRoomPage } from './pages/CreateRoomPage';
import { JoinRoomPage } from './pages/JoinRoomPage';
import './App.css';

// Create a client for React Query
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function App() {
  const wsUrl = process.env.REACT_APP_WS_URL || 'http://localhost:3000';

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SocketProvider serverUrl={wsUrl}>
          <Router>
            <div className="App">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/create-room" element={<CreateRoomPage />} />
                <Route path="/join-room/:roomCode" element={<JoinRoomPage />} />
                <Route path="/room/:roomCode" element={<RoomPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <Toaster position="top-right" />
            </div>
          </Router>
        </SocketProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;