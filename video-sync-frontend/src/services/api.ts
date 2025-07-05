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
  createRoom: (data: { name: string; videoUrl?: string; userId: string }) =>
    api.post('/rooms', data),
  
  getRoom: (code: string) =>
    api.get(`/rooms/${code}`),
  
  getUserRooms: (userId: string) =>
    api.get(`/rooms/user/${userId}`),
};

export { api };