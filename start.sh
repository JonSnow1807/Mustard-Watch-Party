#!/bin/bash

echo "🍿 Starting Mustard Watch Party..."

# Check if PostgreSQL is running
if ! brew services list | grep postgresql@14 | grep started > /dev/null; then
    echo "📦 Starting PostgreSQL..."
    brew services start postgresql@14
    sleep 3
fi

# Start Backend
echo "🔧 Starting Backend..."
cd video-sync-backend
npm run start:dev &
BACKEND_PID=$!

# Wait a moment for backend to start
sleep 5

# Start Frontend
echo "🎨 Starting Frontend..."
cd ../video-sync-frontend
PORT=3001 npm start &
FRONTEND_PID=$!

echo "✅ Both servers are starting..."
echo "🌐 Backend: http://localhost:3000"
echo "🎬 Frontend: http://localhost:3001"
echo ""
echo "Press Ctrl+C to stop both servers"

# Wait for user to stop
trap "echo '🛑 Stopping servers...'; kill $BACKEND_PID $FRONTEND_PID; exit" INT
wait 