# Save this as test-api.sh and run it
#!/bin/bash

echo "🧪 Testing Video Sync API..."

# 1. Register a user
echo -e "\n📝 Registering user..."
USER_RESPONSE=$(curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser'$(date +%s)'",
    "email": "test'$(date +%s)'@example.com",
    "password": "password123"
  }')

echo "Response: $USER_RESPONSE"
USER_ID=$(echo $USER_RESPONSE | grep -o '"id":"[^"]*' | cut -d'"' -f4)
# register/login return the bearer token every guarded REST route needs -
# identity comes from this token now, never from a userId in a body
TOKEN=$(echo $USER_RESPONSE | grep -o '"token":"[^"]*' | cut -d'"' -f4)

# 2. Create a room
echo -e "\n🏠 Creating room..."
ROOM_RESPONSE=$(curl -s -X POST http://localhost:3000/api/rooms \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "name": "Test Room",
    "videoUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
  }')

echo "Response: $ROOM_RESPONSE"
ROOM_CODE=$(echo $ROOM_RESPONSE | grep -o '"code":"[^"]*' | cut -d'"' -f4)

# 3. Get room details
echo -e "\n🔍 Getting room details..."
curl -s http://localhost:3000/api/rooms/$ROOM_CODE \
  -H "Authorization: Bearer $TOKEN" | jq .

echo -e "\n✅ API test complete!"
