import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { SocketProvider } from './contexts/SocketContext';
import { AuthProvider } from './contexts/AuthContext';
import { HomePage } from './pages/HomePage';
import { EnhancedRoomPage } from './pages/EnhancedRoomPage';
import { LoginPage } from './pages/LoginPage';
import { CreateRoomPage } from './pages/CreateRoomPage';
import { JoinRoomPage } from './pages/JoinRoomPage';
import { color, font, radius } from './theme';
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
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SocketProvider>
          <Router>
            <div className="App">
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/login" element={<LoginPage />} />
                <Route path="/create-room" element={<CreateRoomPage />} />
                <Route path="/join-room/:roomCode" element={<JoinRoomPage />} />
                <Route path="/room/:roomCode" element={<EnhancedRoomPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              <Toaster
                position="top-right"
                toastOptions={{
                  style: {
                    background: color.bg2,
                    color: color.text,
                    border: `1px solid ${color.line}`,
                    borderRadius: radius.md,
                    fontFamily: font.body,
                    fontSize: '13px',
                  },
                  success: { iconTheme: { primary: color.ok, secondary: color.bg0 } },
                  error: { iconTheme: { primary: color.danger, secondary: color.bg0 } },
                }}
              />
            </div>
          </Router>
        </SocketProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;