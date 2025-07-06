# 🍿 Mustard Watch Party

Real-time video synchronization platform that lets you watch YouTube videos together with friends, no matter where they are.

![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-%5E5.0.0-blue.svg)

## ✨ Features

- **Real-time Synchronization** - Watch videos in perfect sync with <500ms latency
- **Multi-room Support** - Create unlimited rooms for different watch parties
- **User Authentication** - Secure login and registration system
- **Participant Tracking** - See who's watching with you in real-time
- **YouTube Integration** - Supports all YouTube videos via iframe API
- **Responsive Design** - Works on desktop and mobile devices

## 🛠️ Tech Stack

### Backend
- **NestJS** - Progressive Node.js framework
- **Socket.IO** - Real-time bidirectional communication
- **Prisma** - Next-generation ORM for PostgreSQL
- **PostgreSQL** - Relational database
- **JWT** - Authentication tokens

### Frontend
- **React** - UI library
- **TypeScript** - Type safety
- **Socket.IO Client** - WebSocket connection
- **Emotion** - CSS-in-JS styling
- **React Query** - Data fetching and caching

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 15+
- npm or yarn

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/JonSnow1807/Mustard-Watch-Party.git
cd Mustard-Watch-Party
```

2. **Backend Setup**
```bash
cd video-sync-backend
npm install

# Create .env file
cp .env.example .env
# Edit .env with your database credentials

# Run database migrations
npx prisma migrate dev

# Start backend (port 3000)
npm run start:dev
```

3. **Frontend Setup**
```bash
cd ../video-sync-frontend
npm install

# Create .env file
echo "REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_WS_URL=http://localhost:3000
PORT=3001" > .env

# Start frontend (port 3001)
npm start
```

## 📖 Usage

1. **Register/Login** - Create an account or login
2. **Create Room** - Enter room name and YouTube URL
3. **Share Room Code** - Give the code to friends
4. **Watch Together** - Videos stay in sync automatically!

## 🏗️ Architecture

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   React     │ ←────────────────→ │   NestJS    │
│  Frontend   │                    │   Backend   │
└─────────────┘                    └──────┬──────┘
                                          │
                                    ┌─────▼─────┐
                                    │PostgreSQL │
                                    │    DB     │
                                    └───────────┘
```

### Key Components

- **WebSocket Gateway** - Handles real-time video state synchronization
- **Room Service** - Manages room creation and participant tracking
- **Auth Service** - JWT-based authentication
- **Video Player** - YouTube iframe API integration with sync logic

## 🐳 Docker Support

```bash
# Run with Docker Compose
docker-compose up --build

# Access at:
# Frontend: http://localhost:3001
# Backend: http://localhost:3000
```

## 🔧 Environment Variables

### Backend (.env)
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/videosync
PORT=3000
FRONTEND_URL=http://localhost:3001
JWT_SECRET=your-secret-key
```

### Frontend (.env)
```env
REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_WS_URL=http://localhost:3000
PORT=3001
```

## 📝 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login user |
| POST | `/api/rooms` | Create room |
| GET | `/api/rooms/:code` | Get room details |


## 📄 License

This project is licensed under the Apache 2.0 License.

## 🙏 Acknowledgments

- Built with ❤️ for movie nights with friends
- Inspired by the need to stay connected while apart

---
**Happy Watching! 🎬**
