import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// API methods
export const apiService = {
  // Auth
  login: (username: string, password: string) =>
    api.post('/auth/login', { username, password }),
  
  register: (username: string, email: string, password: string) =>
    api.post('/auth/register', { username, email, password }),
  
  // Rooms
  createRoom: (data: { name: string; videoUrl?: string; userId: string; isPublic?: boolean; description?: string; tags?: string[] }) =>
    api.post('/rooms', data),
  
  getRoom: (code: string) =>
    api.get(`/rooms/${code}`),
  
  updateRoom: (id: string, data: any) =>
    api.patch(`/rooms/${id}`, data),
  
  getUserRooms: (userId: string) =>
    api.get(`/rooms/user/${userId}`),
    
  getPublicRooms: (filter?: string) =>
    api.get('/rooms/public', { params: { filter } }),

  // Room management
  pauseRoom: (roomId: string, creatorId: string) =>
    api.post(`/rooms/${roomId}/pause`, { creatorId }),
  
  endRoom: (roomId: string, creatorId: string) =>
    api.post(`/rooms/${roomId}/end`, { creatorId }),
  
  resumeRoom: (roomId: string, creatorId: string) =>
    api.post(`/rooms/${roomId}/resume`, { creatorId }),
};

export { api };