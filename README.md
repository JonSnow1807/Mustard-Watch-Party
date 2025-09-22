# 🍿 Mustard Watch Party

Real-time video synchronization platform that lets you watch YouTube videos together with friends, no matter where they are.

![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![TypeScript](https://img.shields.io/badge/typescript-%5E5.0.0-blue.svg)

## ✨ Features

- **Real-time Synchronization** - Watch videos in perfect sync with latency monitoring
- **Unlimited Rooms** - Create unlimited rooms with no user limits
- **User Authentication** - Secure login and registration system
- **Participant Tracking** - See who's watching with you in real-time
- **YouTube Integration** - Supports all YouTube videos via iframe API
- **Responsive Design** - Works on desktop and mobile devices
- **Voice Chat** - Built-in WebRTC voice communication
- **Collaborative Control** - Optional setting to allow all participants to control video
- **Room Management** - Public/private rooms with tags and descriptions

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

## 🚀 Complete Setup Guide

### Prerequisites
Make sure you have these installed:
- **Node.js** (v18 or higher)
- **PostgreSQL** (v14 or higher)
- **npm** or **yarn**

### Step 1: Clone and Navigate to Project
```bash
cd Mustard-Watch-Party
```

### Step 2: Set Up Database

1. **Start PostgreSQL service:**
   ```bash
   brew services start postgresql@14
   ```

2. **Create database and user:**
   ```bash
   psql postgres -c "CREATE USER videouser WITH PASSWORD 'videopass';"
   psql postgres -c "CREATE DATABASE videosync OWNER videouser;"
   psql postgres -c "GRANT ALL PRIVILEGES ON DATABASE videosync TO videouser;"
   ```

### Step 3: Set Up Backend

1. **Navigate to backend directory:**
   ```bash
   cd video-sync-backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create environment file (.env):**
   ```bash
   echo 'DATABASE_URL="postgresql://videouser:videopass@localhost:5432/videosync"' > .env
   echo 'JWT_SECRET="your-super-secret-jwt-key-change-this-in-production"' >> .env
   echo 'PORT=3000' >> .env
   echo 'FRONTEND_URL="http://localhost:3001"' >> .env
   ```

4. **Run database migrations:**
   ```bash
   npx prisma migrate deploy
   ```

5. **Start the backend server:**
   ```bash
   npm run start:dev
   ```

   **Expected output:** You should see:
   ```
   ✅ Database connected successfully
   🚀 Server is running on http://localhost:3000
   🔌 WebSocket server is ready for connections
   ```

### Step 4: Set Up Frontend

1. **Open a new terminal and navigate to frontend directory:**
   ```bash
   cd video-sync-frontend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Create environment file (.env):**
   ```bash
   echo 'REACT_APP_API_URL=http://localhost:3000/api' > .env
   echo 'REACT_APP_WS_URL=ws://localhost:3000' >> .env
   ```

4. **Start the frontend server:**
   ```bash
   PORT=3001 npm start
   ```

   **Expected output:** You should see:
   ```
   Compiled successfully!
   You can now view video-sync-frontend in the browser.
   Local:            http://localhost:3001
   ```

### Step 5: Access the Application

1. **Backend API:** http://localhost:3000/api
2. **Frontend App:** http://localhost:3001

### Step 6: Test the Setup

1. **Test backend API:**
   ```bash
   curl http://localhost:3000/api/rooms/public
   ```
   Should return: `[]`

2. **Test frontend:**
   Open http://localhost:3001 in your browser

### Troubleshooting

**If backend fails to start:**
- Check if PostgreSQL is running: `brew services list | grep postgres`
- Verify database connection: `psql -U videouser -d videosync -h localhost`

**If frontend fails to start:**
- Make sure port 3001 is available
- Check if backend is running on port 3000

**If you get database errors:**
- Drop and recreate the database:
  ```bash
  psql postgres -c "DROP DATABASE IF EXISTS videosync;"
  psql postgres -c "CREATE DATABASE videosync OWNER videouser;"
  npx prisma migrate deploy
  ```

### Quick Start Script

You can create a quick start script. Create a file called `start.sh` in the root directory:

```bash
#!/bin/bash

# Start PostgreSQL
brew services start postgresql@14

# Start Backend
cd video-sync-backend
npm run start:dev &

# Start Frontend
cd ../video-sync-frontend
PORT=3001 npm start
```

Make it executable: `chmod +x start.sh`

### Port Configuration Summary

- **Backend API:** http://localhost:3000
- **Frontend App:** http://localhost:3001
- **WebSocket:** ws://localhost:3000
- **Database:** localhost:5432

---

## 🚀 Quick Start (Legacy - Commented Out)

<!-- 
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
-->

## 🚀 Commands to Run Your Project Locally

### Option 1: Manual Start (Recommended for Development)

**Terminal 1 - Start Backend:**
```bash
cd Mustard-Watch-Party/video-sync-backend
npm run start:dev
```

**Terminal 2 - Start Frontend:**
```bash
cd Mustard-Watch-Party/video-sync-frontend
PORT=3001 npm start
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
DATABASE_URL=postgresql://videouser:videopass@localhost:5432/videosync
PORT=3000
FRONTEND_URL=http://localhost:3001
JWT_SECRET=your-secret-key
```

### Frontend (.env)
```env
REACT_APP_API_URL=http://localhost:3000/api
REACT_APP_WS_URL=ws://localhost:3000
PORT=3001
```

## 📝 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register new user |
| POST | `/api/auth/login` | Login user |
| POST | `/api/rooms` | Create room (supports allowGuestControl flag) |
| GET | `/api/rooms/public` | List public rooms |
| GET | `/api/rooms/:code` | Get room details |
| GET | `/api/rooms/user/:userId` | User's rooms |
| PATCH | `/api/rooms/:code` | Update room |
| DELETE | `/api/rooms/:code` | Delete room (host only) |


## 📄 License

This project is licensed under the Apache 2.0 License.

## 🙏 Acknowledgments

- Built with ❤️ for movie nights with friends
- Inspired by the need to stay connected while apart

---
**Happy Watching! 🎬**
