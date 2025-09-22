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

interface VoiceUser {
  userId: string;
  username: string;
  socketId: string;
  roomCode: string;
  isMuted: boolean;
  isDeafened: boolean;
}

interface SignalData {
  to: string;
  from: string;
  signal: any;
  username: string;
  userId: string;
}

@WebSocketGateway({
  namespace: '/voice',
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private voiceUsers: Map<string, VoiceUser> = new Map();
  private roomVoiceUsers: Map<string, Set<string>> = new Map();

  async handleConnection(client: Socket) {
    console.log(`Voice client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Voice client disconnected: ${client.id}`);
    const user = this.voiceUsers.get(client.id);

    if (user) {
      await this.handleLeaveVoice(client, { roomCode: user.roomCode, userId: user.userId });
    }
  }

  @SubscribeMessage('join-voice-chat')
  async handleJoinVoiceChat(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      username: string;
    },
  ) {
    try {
      console.log(`${data.username} joining voice chat in room ${data.roomCode}`);

      // Store user info
      const voiceUser: VoiceUser = {
        userId: data.userId,
        username: data.username,
        socketId: client.id,
        roomCode: data.roomCode,
        isMuted: false,
        isDeafened: false,
      };

      this.voiceUsers.set(client.id, voiceUser);

      // Add to room set
      if (!this.roomVoiceUsers.has(data.roomCode)) {
        this.roomVoiceUsers.set(data.roomCode, new Set());
      }
      this.roomVoiceUsers.get(data.roomCode)!.add(client.id);

      // Join voice room
      await client.join(`voice-${data.roomCode}`);

      // Get existing users in the room
      const existingUsers = Array.from(this.roomVoiceUsers.get(data.roomCode) || [])
        .filter(id => id !== client.id)
        .map(id => this.voiceUsers.get(id))
        .filter(Boolean) as VoiceUser[];

      // Send existing users to the new user
      client.emit('voice-users-list', {
        users: existingUsers.map(u => ({
          userId: u.userId,
          username: u.username,
          socketId: u.socketId,
          isMuted: u.isMuted,
          isDeafened: u.isDeafened,
        })),
      });

      // Notify others that a new user joined
      client.to(`voice-${data.roomCode}`).emit('voice-user-joined', {
        userId: data.userId,
        username: data.username,
        socketId: client.id,
      });

    } catch (error) {
      console.error('Error joining voice chat:', error);
      client.emit('voice-error', { message: 'Failed to join voice chat' });
    }
  }

  @SubscribeMessage('leave-voice-chat')
  async handleLeaveVoice(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
    },
  ) {
    try {
      console.log(`User ${data.userId} leaving voice chat in room ${data.roomCode}`);

      // Remove from maps
      this.voiceUsers.delete(client.id);

      const roomUsers = this.roomVoiceUsers.get(data.roomCode);
      if (roomUsers) {
        roomUsers.delete(client.id);
        if (roomUsers.size === 0) {
          this.roomVoiceUsers.delete(data.roomCode);
        }
      }

      // Leave voice room
      await client.leave(`voice-${data.roomCode}`);

      // Notify others
      client.to(`voice-${data.roomCode}`).emit('voice-user-left', {
        userId: data.userId,
        socketId: client.id,
      });

    } catch (error) {
      console.error('Error leaving voice chat:', error);
    }
  }

  @SubscribeMessage('voice-signal')
  async handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SignalData,
  ) {
    try {
      // Find target socket
      const targetSocket = [...this.server.sockets.sockets.values()]
        .find(s => s.id === data.to);

      if (targetSocket) {
        targetSocket.emit('voice-signal', {
          from: client.id,
          signal: data.signal,
          username: data.username,
          userId: data.userId,
        });
      }
    } catch (error) {
      console.error('Error handling voice signal:', error);
    }
  }

  @SubscribeMessage('voice-mute-toggle')
  async handleMuteToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      isMuted: boolean;
    },
  ) {
    try {
      const user = this.voiceUsers.get(client.id);
      if (user) {
        user.isMuted = data.isMuted;
      }

      // Notify all users in the room
      this.server.to(`voice-${data.roomCode}`).emit('voice-mute-status', {
        userId: data.userId,
        socketId: client.id,
        isMuted: data.isMuted,
      });

    } catch (error) {
      console.error('Error handling mute toggle:', error);
    }
  }

  @SubscribeMessage('voice-deafen-toggle')
  async handleDeafenToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      isDeafened: boolean;
    },
  ) {
    try {
      const user = this.voiceUsers.get(client.id);
      if (user) {
        user.isDeafened = data.isDeafened;
        // If deafened, also mute
        if (data.isDeafened) {
          user.isMuted = true;
        }
      }

      // Notify all users in the room
      this.server.to(`voice-${data.roomCode}`).emit('voice-deafen-status', {
        userId: data.userId,
        socketId: client.id,
        isDeafened: data.isDeafened,
        isMuted: user?.isMuted || false,
      });

    } catch (error) {
      console.error('Error handling deafen toggle:', error);
    }
  }

  @SubscribeMessage('voice-speaking')
  async handleSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      roomCode: string;
      userId: string;
      isSpeaking: boolean;
    },
  ) {
    try {
      // Broadcast speaking status to all users in the room
      client.to(`voice-${data.roomCode}`).emit('voice-speaking-status', {
        userId: data.userId,
        socketId: client.id,
        isSpeaking: data.isSpeaking,
      });
    } catch (error) {
      console.error('Error handling speaking status:', error);
    }
  }

  @SubscribeMessage('request-voice-offer')
  async handleRequestOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      to: string;
      from: string;
      roomCode: string;
    },
  ) {
    try {
      const targetSocket = [...this.server.sockets.sockets.values()]
        .find(s => s.id === data.to);

      if (targetSocket) {
        targetSocket.emit('voice-offer-request', {
          from: client.id,
          roomCode: data.roomCode,
        });
      }
    } catch (error) {
      console.error('Error requesting voice offer:', error);
    }
  }
}