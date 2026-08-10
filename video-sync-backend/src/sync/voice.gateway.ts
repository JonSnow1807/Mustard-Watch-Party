import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { AuthedSocketData, wsAuthMiddleware } from './ws-auth';

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
  signal: unknown;
  username: string;
  userId: string;
}

@WebSocketGateway({
  namespace: '/voice',
  cors: {
    origin: (process.env.FRONTEND_URL || 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
})
export class VoiceGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private voiceUsers: Map<string, VoiceUser> = new Map();
  private roomVoiceUsers: Map<string, Set<string>> = new Map();

  /**
   * Broadcast who is on the call to the WHOLE room, not just the call.
   *
   * The roster used to go only to the person joining ('voice-users-list' on
   * their own socket), so anyone deciding whether to join could not see
   * whether they would be walking into an empty call or interrupting three
   * people. This goes to the room channel, which everyone watching is
   * already in.
   */
  private broadcastVoiceRoster(roomCode: string): void {
    const ids = Array.from(this.roomVoiceUsers.get(roomCode) ?? []);
    const users = ids
      .map((id) => this.voiceUsers.get(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u))
      .map((u) => ({ userId: u.userId, username: u.username }));
    this.server?.to(roomCode).emit('voice-roster', { roomCode, users });
  }

  constructor(private jwt: JwtService) {}

  afterInit(server: Server): void {
    server.use(wsAuthMiddleware(this.jwt));
  }

  /**
   * Identity comes from the verified JWT, never from the payload: the
   * middleware authenticates the socket, so trusting body userIds would let
   * any authenticated client impersonate anyone in the voice roster.
   */
  /**
   * The voice room this socket ACTUALLY joined, from the server's own
   * roster. Handlers previously broadcast to `voice-${data.roomCode}` -
   * a client-supplied value - so any authenticated socket could inject
   * mute/deafen/speaking events into a room it had never joined
   * (CWE-862). The payload's roomCode is now advisory at best.
   */
  private joinedRoom(client: Socket): string | null {
    return this.voiceUsers.get(client.id)?.roomCode ?? null;
  }

  private identity(client: Socket): { userId: string; username: string } {
    const data = client.data as AuthedSocketData;
    return { userId: data.userId, username: data.username };
  }

  handleConnection(client: Socket) {
    console.log(`Voice client connected: ${client.id}`);
  }

  async handleDisconnect(client: Socket) {
    console.log(`Voice client disconnected: ${client.id}`);
    const user = this.voiceUsers.get(client.id);

    if (user) {
      await this.handleLeaveVoice(client);
    }
  }

  @SubscribeMessage('join-voice-chat')
  async handleJoinVoiceChat(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      userId: string;
      username: string;
    },
  ) {
    try {
      console.log(
        `${this.identity(client).username} joining voice in ${data.roomCode}`,
      );

      // Store user info
      const voiceUser: VoiceUser = {
        userId: this.identity(client).userId,
        username: this.identity(client).username,
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
      const existingUsers = Array.from(
        this.roomVoiceUsers.get(data.roomCode) || [],
      )
        .filter((id) => id !== client.id)
        .map((id) => this.voiceUsers.get(id))
        .filter(Boolean) as VoiceUser[];

      // Send existing users to the new user
      client.emit('voice-users-list', {
        users: existingUsers.map((u) => ({
          userId: u.userId,
          username: u.username,
          socketId: u.socketId,
          isMuted: u.isMuted,
          isDeafened: u.isDeafened,
        })),
      });

      // Notify others that a new user joined
      this.broadcastVoiceRoster(data.roomCode);

      client.to(`voice-${data.roomCode}`).emit('voice-user-joined', {
        userId: this.identity(client).userId,
        username: this.identity(client).username,
        socketId: client.id,
      });
    } catch (error) {
      console.error('Error joining voice chat:', error);
      client.emit('voice-error', { message: 'Failed to join voice chat' });
    }
  }

  @SubscribeMessage('leave-voice-chat')
  async handleLeaveVoice(@ConnectedSocket() client: Socket) {
    try {
      // the room comes from the server's roster, never the payload
      const room = this.joinedRoom(client);
      if (!room) return;
      console.log(
        `User ${this.identity(client).userId} leaving voice in ${room}`,
      );

      // Remove from maps
      this.voiceUsers.delete(client.id);

      const roomUsers = this.roomVoiceUsers.get(room);
      if (roomUsers) {
        roomUsers.delete(client.id);
        if (roomUsers.size === 0) {
          this.roomVoiceUsers.delete(room);
        }
      }

      // Leave voice room
      await client.leave(`voice-${room}`);

      // Notify others
      this.broadcastVoiceRoster(room);

      client.to(`voice-${room}`).emit('voice-user-left', {
        userId: this.identity(client).userId,
        socketId: client.id,
      });
    } catch (error) {
      console.error('Error leaving voice chat:', error);
    }
  }

  @SubscribeMessage('voice-signal')
  handleVoiceSignal(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SignalData,
  ) {
    try {
      // Find target socket
      const targetSocket = [...this.server.sockets.sockets.values()].find(
        (s) => s.id === data.to,
      );

      if (targetSocket) {
        targetSocket.emit('voice-signal', {
          from: client.id,
          signal: data.signal,
          username: this.identity(client).username,
          userId: this.identity(client).userId,
        });
      }
    } catch (error) {
      console.error('Error handling voice signal:', error);
    }
  }

  @SubscribeMessage('voice-mute-toggle')
  handleMuteToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      userId: string;
      isMuted: boolean;
    },
  ) {
    try {
      const room = this.joinedRoom(client);
      if (!room) return; // not in a voice room: nothing to broadcast into
      const user = this.voiceUsers.get(client.id);
      if (user) {
        user.isMuted = data.isMuted;
      }

      // Notify all users in the room
      this.server.to(`voice-${room}`).emit('voice-mute-status', {
        userId: this.identity(client).userId,
        socketId: client.id,
        isMuted: data.isMuted,
      });
    } catch (error) {
      console.error('Error handling mute toggle:', error);
    }
  }

  @SubscribeMessage('voice-deafen-toggle')
  handleDeafenToggle(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      userId: string;
      isDeafened: boolean;
    },
  ) {
    try {
      const room = this.joinedRoom(client);
      if (!room) return;
      const user = this.voiceUsers.get(client.id);
      if (user) {
        user.isDeafened = data.isDeafened;
        // If deafened, also mute
        if (data.isDeafened) {
          user.isMuted = true;
        }
      }

      // Notify all users in the room
      this.server.to(`voice-${room}`).emit('voice-deafen-status', {
        userId: this.identity(client).userId,
        socketId: client.id,
        isDeafened: data.isDeafened,
        isMuted: user?.isMuted || false,
      });
    } catch (error) {
      console.error('Error handling deafen toggle:', error);
    }
  }

  @SubscribeMessage('voice-speaking')
  handleSpeaking(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      roomCode: string;
      userId: string;
      isSpeaking: boolean;
    },
  ) {
    try {
      const room = this.joinedRoom(client);
      if (!room) return;
      // Broadcast speaking status to all users in the room
      client.to(`voice-${room}`).emit('voice-speaking-status', {
        userId: this.identity(client).userId,
        socketId: client.id,
        isSpeaking: data.isSpeaking,
      });
    } catch (error) {
      console.error('Error handling speaking status:', error);
    }
  }

  @SubscribeMessage('request-voice-offer')
  handleRequestOffer(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
      to: string;
      from: string;
      roomCode: string;
    },
  ) {
    try {
      const targetSocket = [...this.server.sockets.sockets.values()].find(
        (s) => s.id === data.to,
      );

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
