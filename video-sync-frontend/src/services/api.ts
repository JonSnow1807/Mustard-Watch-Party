import axios from 'axios';

// Get API URL from environment or fallback to localhost
const getApiUrl = () => {
  return process.env.REACT_APP_API_URL || 'http://localhost:3000/api';
};

const API_URL = getApiUrl();

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
  createRoom: (data: {
    name: string;
    videoUrl?: string;
    userId: string;
    isPublic?: boolean;
    description?: string;
    tags?: string[];
    allowGuestControl?: boolean;
  }) => api.post('/rooms', data),
  
  getRoomByCode: (code: string) =>
    api.get(`/rooms/${code}`),
  
  updateRoom: (code: string, data: {
    name?: string;
    videoUrl?: string;
    userId?: string;
    allowGuestControl?: boolean;
  }) => api.patch(`/rooms/${code}`, data),
  
  deleteRoom: (code: string, userId: string) =>
    api.delete(`/rooms/${code}`, { data: { userId } }),
  
  getUserRooms: (userId: string) =>
    api.get(`/rooms/user/${userId}`),
    
  getPublicRooms: (filter?: string) =>
    api.get('/rooms/public', { params: { filter } }),
};

export { api };