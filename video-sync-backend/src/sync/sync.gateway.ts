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
  latency?: number; // Track sync latency
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

  private roomStates: Map<string, VideoState> = new Map();
  private userRooms: Map<string, string> = new Map();
  private roomHosts: Map<string, string> = new Map(); // Track room hosts
  private socketToUser: Map<string, string> = new Map(); // Map socket.id to userId

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
      const joinStartTime = Date.now();
      console.log(`User ${data.userId} joining room ${data.roomCode}`);
      
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

      await client.join(data.roomCode);
      this.userRooms.set(client.id, data.roomCode);
      this.socketToUser.set(client.id, data.userId);
      
      // Set room host if first user
      if (!this.roomHosts.has(data.roomCode)) {
        this.roomHosts.set(data.roomCode, data.userId);
      }

      // Upsert participant
      const participant = await this.database.participant.upsert({
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
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      // Get updated participants list
      const updatedParticipants = await this.database.participant.findMany({
        where: {
          roomId: room.id,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      const currentState = this.roomStates.get(data.roomCode) || {
        currentTime: room.currentTime,
        isPlaying: room.isPlaying,
        timestamp: Date.now(),
      };

      console.log(`Sending room state to ${data.userId}:`, currentState);

      // Calculate join latency
      const joinLatency = Date.now() - joinStartTime;

      // Send to joining user with latency info
      client.emit('room-joined', {
        room: {
          id: room.id,
          name: room.name,
          code: room.code,
          videoUrl: room.videoUrl,
          creatorId: room.creatorId,
        },
        state: currentState,
        participants: updatedParticipants.map(p => ({
          id: p.user.id,
          username: p.user.username,
        })),
        latency: joinLatency,
      });

      // Log latency for monitoring
      if (joinLatency > 500) {
        console.warn(`⚠️ High join latency: ${joinLatency}ms for user ${data.userId}`);
      }

      // Notify others with updated participant info
      client.to(data.roomCode).emit('user-joined', {
        userId: participant.user.id,
        username: participant.user.username,
      });
      
      // Send updated participants list to all users in room (except the joining user)
      client.to(data.roomCode).emit('participants-update', {
        participants: updatedParticipants.map(p => ({
          id: p.user.id,
          username: p.user.username,
        })),
      });
      
      // Send chat history to the joining user
      this.handleGetMessageHistory(client, { roomCode: data.roomCode });

    } catch (error) {
      console.error('Error joining room:', error);
      client.emit('error', { message: 'Failed to join room' });
    }
  }

  @SubscribeMessage('request-participants')
  async handleRequestParticipants(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    try {
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        select: { id: true },
      });

      if (!room) return;

      const participants = await this.database.participant.findMany({
        where: {
          roomId: room.id,
          isActive: true,
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });

      client.emit('participants-update', {
        participants: participants.map(p => ({
          id: p.user.id,
          username: p.user.username,
        })),
      });
    } catch (error) {
      console.error('Error fetching participants:', error);
    }
  }

  @SubscribeMessage('video-state')
  async handleVideoState(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      state: VideoState;
      action?: string;
      clientTimestamp?: number;
    },
  ) {
    try {
      const syncStartTime = Date.now();
      const { roomCode, state, action, clientTimestamp } = data;
      const userId = this.socketToUser.get(client.id);
      
      // Check if user is the host (creator) of the room or if guest control is allowed
      const room = await this.database.room.findUnique({
        where: { code: roomCode },
        select: { creatorId: true, allowGuestControl: true },
      });

      if (!room) {
        client.emit('error', { message: 'Room not found' });
        return;
      }

      // Check permissions
      if (!room.allowGuestControl && room.creatorId !== userId) {
        client.emit('error', { message: 'Only the host can control video playback' });
        return;
      }
      
      console.log(`Video ${action || 'state'} update in room ${roomCode}:`, state);
      
      // Update stored state
      this.roomStates.set(roomCode, state);
      
      // Calculate sync latency if client timestamp provided
      const syncLatency = clientTimestamp ? Date.now() - clientTimestamp : undefined;

      // Broadcast to other users with action type and latency
      client.to(roomCode).emit('video-state-update', {
        ...state,
        action,
        latency: syncLatency,
        serverTimestamp: Date.now()
      });

      // Log high latency
      if (syncLatency && syncLatency > 500) {
        console.warn(`⚠️ High sync latency: ${syncLatency}ms for room ${roomCode}`);
      }
      
      // Schedule database update (debounced)
      this.scheduleDatabaseUpdate(roomCode, state);
    } catch (error) {
      console.error('Error syncing video state:', error);
    }
  }

  @SubscribeMessage('ping')
  async handlePing(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { timestamp: number },
  ) {
    // Immediately respond with pong for latency measurement
    client.emit('pong', {
      clientTimestamp: data.timestamp,
      serverTimestamp: Date.now(),
    });
  }

  @SubscribeMessage('sync-check')
  async handleSyncCheck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      currentTime: number;
      isPlaying: boolean;
      clientTimestamp?: number;
    },
  ) {
    try {
      // This is for periodic sync checks
      // Only update if there's a significant difference
      const roomState = this.roomStates.get(data.roomCode);
      if (roomState) {
        const timeDiff = Math.abs(roomState.currentTime - data.currentTime);
        if (timeDiff > 3) {
          // Only sync if difference is more than 3 seconds
          const latency = data.clientTimestamp ? Date.now() - data.clientTimestamp : undefined;
          client.emit('video-state-update', {
            ...roomState,
            action: 'sync-check',
            latency,
            serverTimestamp: Date.now()
          });
        }
      }
    } catch (error) {
      console.error('Error handling sync check:', error);
    }
  }

  @SubscribeMessage('play-video')
  async handlePlayVideo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string; time?: number },
  ) {
    try {
      const userId = this.socketToUser.get(client.id);
      
      // Check if user is the host (creator) of the room or if guest control is allowed
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        select: { creatorId: true, allowGuestControl: true },
      });

      if (!room) {
        client.emit('error', { message: 'Room not found' });
        return;
      }

      // Check permissions
      if (!room.allowGuestControl && room.creatorId !== userId) {
        client.emit('error', { message: 'Only the host can control video playback' });
        return;
      }
      
      const state: VideoState = {
        currentTime: data.time || 0,
        isPlaying: true,
        timestamp: Date.now(),
      };
      
      this.roomStates.set(data.roomCode, state);
      client.to(data.roomCode).emit('video-state-update', {
        ...state,
        action: 'play'
      });
      
      console.log(`Play video in room ${data.roomCode} at ${data.time}s`);
    } catch (error) {
      console.error('Error handling play video:', error);
    }
  }

  @SubscribeMessage('pause-video')
  async handlePauseVideo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string; time?: number },
  ) {
    try {
      const userId = this.socketToUser.get(client.id);
      
      // Check if user is the host (creator) of the room or if guest control is allowed
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        select: { creatorId: true, allowGuestControl: true },
      });

      if (!room) {
        client.emit('error', { message: 'Room not found' });
        return;
      }

      // Check permissions
      if (!room.allowGuestControl && room.creatorId !== userId) {
        client.emit('error', { message: 'Only the host can control video playback' });
        return;
      }
      
      const state: VideoState = {
        currentTime: data.time || 0,
        isPlaying: false,
        timestamp: Date.now(),
      };
      
      this.roomStates.set(data.roomCode, state);
      client.to(data.roomCode).emit('video-state-update', {
        ...state,
        action: 'pause'
      });
      
      console.log(`Pause video in room ${data.roomCode} at ${data.time}s`);
    } catch (error) {
      console.error('Error handling pause video:', error);
    }
  }

  @SubscribeMessage('seek-video')
  async handleSeekVideo(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string; time: number },
  ) {
    try {
      const userId = this.socketToUser.get(client.id);
      
      // Check if user is the host (creator) of the room or if guest control is allowed
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        select: { creatorId: true, allowGuestControl: true },
      });

      if (!room) {
        client.emit('error', { message: 'Room not found' });
        return;
      }

      // Check permissions
      if (!room.allowGuestControl && room.creatorId !== userId) {
        client.emit('error', { message: 'Only the host can control video playback' });
        return;
      }
      
      const roomState = this.roomStates.get(data.roomCode);
      const state: VideoState = {
        currentTime: data.time,
        isPlaying: roomState?.isPlaying || false,
        timestamp: Date.now(),
      };
      
      this.roomStates.set(data.roomCode, state);
      client.to(data.roomCode).emit('video-state-update', {
        ...state,
        action: 'seek'
      });
      
      console.log(`Seek video in room ${data.roomCode} to ${data.time}s`);
    } catch (error) {
      console.error('Error handling seek video:', error);
    }
  }

  @SubscribeMessage('send-message')
  async handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      message: {
        userId: string;
        username: string;
        message: string;
      };
    },
  ) {
    try {
      const { roomCode, message } = data;
      console.log(`Chat message in room ${roomCode} from ${message.username}`);
      
      const room = await this.database.room.findUnique({
        where: { code: roomCode },
        select: { id: true },
      });
      
      if (!room) {
        client.emit('error', { message: 'Room not found' });
        return;
      }
      
      const savedMessage = await this.database.chatMessage.create({
        data: {
          content: message.message,
          userId: message.userId,
          roomId: room.id,
        },
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });
      
      this.server.to(roomCode).emit('chat-message', {
        id: savedMessage.id,
        userId: savedMessage.user.id,
        username: savedMessage.user.username,
        message: savedMessage.content,
        timestamp: savedMessage.createdAt,
      });
    } catch (error) {
      console.error('Error handling chat message:', error);
      client.emit('error', { message: 'Failed to send message' });
    }
  }

  @SubscribeMessage('get-message-history')
  async handleGetMessageHistory(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { roomCode: string },
  ) {
    try {
      const room = await this.database.room.findUnique({
        where: { code: data.roomCode },
        select: { id: true },
      });
      
      if (!room) return;
      
      const messages = await this.database.chatMessage.findMany({
        where: { roomId: room.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: {
          user: {
            select: {
              id: true,
              username: true,
            },
          },
        },
      });
      
      const formattedMessages = messages.reverse().map(msg => ({
        id: msg.id,
        userId: msg.user.id,
        username: msg.user.username,
        message: msg.content,
        timestamp: msg.createdAt,
      }));
      
      client.emit('message-history', formattedMessages);
    } catch (error) {
      console.error('Error getting message history:', error);
    }
  }

  // Voice chat handlers
  @SubscribeMessage('join-voice')
  async handleJoinVoice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      username: string;
    },
  ) {
    try {
      console.log(`${data.username} joined voice in room ${data.roomCode}`);
      
      await client.join(`voice-${data.roomCode}`);
      
      client.to(data.roomCode).emit('voice-user-joined', {
        userId: data.userId,
        username: data.username,
        peerId: client.id,
      });
    } catch (error) {
      console.error('Error joining voice:', error);
    }
  }

  @SubscribeMessage('leave-voice')
  async handleLeaveVoice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
    },
  ) {
    try {
      console.log(`User ${data.userId} left voice in room ${data.roomCode}`);
      
      await client.leave(`voice-${data.roomCode}`);
      
      client.to(data.roomCode).emit('voice-user-left', {
        userId: data.userId,
      });
    } catch (error) {
      console.error('Error leaving voice:', error);
    }
  }

  @SubscribeMessage('voice-signal')
  async handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      targetUserId: string;
      signal: any;
    },
  ) {
    try {
      const targetSocket = [...this.server.sockets.sockets.values()]
        .find(socket => this.userRooms.get(socket.id) === data.roomCode);
      
      if (targetSocket) {
        targetSocket.emit('voice-signal', {
          userId: data.targetUserId,
          username: 'User',
          signal: data.signal,
        });
      }
    } catch (error) {
      console.error('Error handling voice signal:', error);
    }
  }

  @SubscribeMessage('voice-mute')
  async handleVoiceMute(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      isMuted: boolean;
    },
  ) {
    try {
      client.to(data.roomCode).emit('voice-mute-status', {
        userId: data.userId,
        isMuted: data.isMuted,
      });
    } catch (error) {
      console.error('Error handling mute status:', error);
    }
  }

  @SubscribeMessage('user-activity')
  async handleUserActivity(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      activity: string;
    },
  ) {
    try {
      // Broadcast activity to other users in the room
      client.to(data.roomCode).emit('user-activity', {
        userId: data.userId,
        activity: data.activity,
      });
      
      console.log(`User ${data.userId} is ${data.activity} in room ${data.roomCode}`);
    } catch (error) {
      console.error('Error handling user activity:', error);
    }
  }

  private async handleLeaveRoom(client: Socket, roomCode: string) {
    try {
      const userId = this.socketToUser.get(client.id);
      
      await client.leave(roomCode);
      this.userRooms.delete(client.id);
      this.socketToUser.delete(client.id);

      // Clean up room host if leaving
      const hostId = this.roomHosts.get(roomCode);
      if (hostId === userId) {
        const roomSockets = await this.server.in(roomCode).fetchSockets();
        if (roomSockets.length > 0) {
          // Assign new host to next user
          const newHostSocket = roomSockets[0];
          const newHostId = this.socketToUser.get(newHostSocket.id);
          if (newHostId) {
            this.roomHosts.set(roomCode, newHostId);
          }
        } else {
          // Room is empty, clean up
          this.roomHosts.delete(roomCode);
          this.roomStates.delete(roomCode);
        }
      }

      const room = await this.database.room.findUnique({
        where: { code: roomCode },
        select: { id: true },
      });

      if (room && userId) {
        // Mark participant as inactive
        await this.database.participant.updateMany({
          where: {
            roomId: room.id,
            userId: userId,
          },
          data: {
            isActive: false,
            leftAt: new Date(),
          },
        });

        // Get remaining active participants
        const remainingParticipants = await this.database.participant.findMany({
          where: {
            roomId: room.id,
            isActive: true,
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
              },
            },
          },
        });

        // Notify others
        client.to(roomCode).emit('user-left', {
          userId: userId,
        });

        // Send updated participants list
        this.server.to(roomCode).emit('participants-update', {
          participants: remainingParticipants.map(p => ({
            id: p.user.id,
            username: p.user.username,
          })),
        });
      }

      // Clean up room state if empty
      const roomSockets = await this.server.in(roomCode).fetchSockets();
      if (roomSockets.length === 0) {
        this.roomStates.delete(roomCode);
      }
    } catch (error) {
      console.error('Error handling leave room:', error);
    }
  }

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
    }, 5000); // Update database every 5 seconds

    this.updateTimers.set(roomCode, timer);
  }
}