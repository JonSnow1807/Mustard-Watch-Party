import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { DatabaseService } from '../database/database.service';

interface VideoState {
  currentTime: number;
  isPlaying: boolean;
  timestamp?: number;
}

interface RoomData {
  roomCode: string;
  userId: string;
}

@WebSocketGateway({
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
})
export class SyncGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  // In-memory cache for active room states
  private roomStates: Map<string, VideoState> = new Map();
  private userRooms: Map<string, string> = new Map();

  constructor(private database: DatabaseService) {}

  async handleConnection(client: Socket) {
    console.log(`Client connected: ${client.id}`);
    client.emit('connected', { 
      id: client.id,
      timestamp: Date.now() 
    });
  }

  async handleDisconnect(client: Socket) {
    console.log(`Client disconnected: ${client.id}`);
    
    const roomCode = this.userRooms.get(client.id);
    if (roomCode) {
      await this.handleLeaveRoom(client, roomCode);
    }
  }

  @SubscribeMessage('join-room')
  async handleJoinRoom(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: RoomData,
  ) {
    try {
      console.log(`User ${data.userId} joining room ${data.roomCode}`);
      
      // Get room from database
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        include: {
          participants: {
            where: { isActive: true },
            include: {
              user: {
                select: {
                  id: true,
                  username: true,
                },
              },
            },
          },
        },
      });

      if (!room || !room.isActive) {
        client.emit('error', { message: 'Room not found or inactive' });
        return;
      }

      // Join Socket.IO room
      await client.join(data.roomCode);
      this.userRooms.set(client.id, data.roomCode);

      // Create or update participant record
      await this.database.participant.upsert({
        where: {
          userId_roomId: {
            userId: data.userId,
            roomId: room.id,
          },
        },
        update: {
          isActive: true,
          lastPingAt: new Date(),
        },
        create: {
          userId: data.userId,
          roomId: room.id,
        },
      });

      // Get current room state from memory or database
      const currentState = this.roomStates.get(data.roomCode) || {
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
      };

      console.log(`Sending room state to ${data.userId}:`, currentState);

      // Send room joined confirmation with current state
      client.emit('room-joined', {
        room: {
          id: room.id,
          name: room.name,
          code: room.code,
          videoUrl: room.videoUrl,
        },
        state: currentState,
        participants: room.participants.map(p => ({
          id: p.user.id,
          username: p.user.username,
        })),
      });

      // Notify others in room
      const joiningUser = room.participants.find(p => p.userId === data.userId);
      client.to(data.roomCode).emit('user-joined', {
        userId: data.userId,
        username: joiningUser?.user.username || 'Anonymous',
      });

    } catch (error) {
      console.error('Error joining room:', error);
      client.emit('error', { message: 'Failed to join room' });
    }
  }

  @SubscribeMessage('video-state')
  async handleVideoState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      state: { currentTime: number; isPlaying: boolean };
    },
  ) {
    try {
      const { roomCode, state } = data;
      console.log(`Video state update in room ${roomCode}:`, state);
      
      // Update in-memory state
      this.roomStates.set(roomCode, state);
      
      // Broadcast to all other users in the room
      client.to(roomCode).emit('video-state-update', state);
      
      // Update database periodically (not on every change)
      this.scheduleDatabaseUpdate(roomCode, state);
    } catch (error) {
      console.error('Error syncing video state:', error);
    }
  }

  private async handleLeaveRoom(client: Socket, roomCode: string) {
    try {
      await client.leave(roomCode);
      this.userRooms.delete(client.id);

      const room = await this.database.room.findUnique({
        where: { code: roomCode },
        select: { id: true },
      });

      if (room) {
        await this.database.participant.updateMany({
          where: {
            roomId: room.id,
            isActive: true,
          },
          data: {
            isActive: false,
            leftAt: new Date(),
          },
        });

        client.to(roomCode).emit('user-left', {
          userId: client.id,
        });
      }
    } catch (error) {
      console.error('Error handling leave room:', error);
    }
  }

  // Batch database updates to reduce write load
  private updateTimers: Map<string, NodeJS.Timeout> = new Map();

  private scheduleDatabaseUpdate(roomCode: string, state: VideoState) {
    const existingTimer = this.updateTimers.get(roomCode);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      try {
        await this.database.room.update({
          where: { code: roomCode },
          data: {
            currentTime: state.currentTime,
            isPlaying: state.isPlaying,
            lastSyncAt: new Date(),
          },
        });
        this.updateTimers.delete(roomCode);
      } catch (error) {
        console.error('Error updating room state:', error);
      }
    }, 5000); // 5 second delay

    this.updateTimers.set(roomCode, timer);
  }
}