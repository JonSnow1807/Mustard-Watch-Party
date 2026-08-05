import { Inject, Logger } from '@nestjs/common';
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
import { Interval } from '@nestjs/schedule';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { DatabaseService } from '../database/database.service';
import {
  ClockPing,
  ClockPong,
  SYNC_EVENTS,
  SyncControl,
} from '../shared/sync-protocol';
import { ClockDomainService } from '../redis/clock-domain.service';
import { MetricsService } from '../metrics/metrics.service';
import { TimelineService } from './timeline.service';
import { ActorRoomStateStore } from './actor-room-state.store';
import {
  ROOM_STATE_STORE,
  RoomStateStore,
  SWEEP_INTERVAL_MS,
} from './room-state.store';
import { AuthedSocketData, wsAuthMiddleware } from './ws-auth';

const CONTROL_INTENTS: ReadonlyArray<SyncControl['intent']> = [
  'play',
  'pause',
  'seek',
];

interface RoomData {
  roomCode: string;
  userId: string;
}

@WebSocketGateway({
  cors: {
    origin: (process.env.FRONTEND_URL || 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingInterval: 10000,
  pingTimeout: 5000,
})
export class SyncGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(SyncGateway.name);
  private userRooms: Map<string, string> = new Map();
  private roomHosts: Map<string, string> = new Map(); // Track room hosts
  private socketToUser: Map<string, string> = new Map(); // Map socket.id to userId

  constructor(
    private database: DatabaseService,
    private jwt: JwtService,
    private timeline: TimelineService,
    private clock: ClockDomainService,
    private metrics: MetricsService,
    @Inject(ROOM_STATE_STORE) private store: RoomStateStore,
  ) {
    if (this.store instanceof ActorRoomStateStore) {
      // actor plane: intents forwarded by non-owners execute HERE, on the
      // room's owner, and the resulting timeline fans out to every instance
      // through the socket.io adapter
      this.store.setForwardHandler(async (c) => {
        const result = await this.timeline.handleControl(
          c.roomCode,
          `forward:${c.by}`,
          c.by,
          c.intent,
          c.mediaTime,
          this.clock.now(),
        );
        if (result.ok && result.timeline) {
          this.server
            .to(c.roomCode)
            .emit(SYNC_EVENTS.timeline, result.timeline);
        }
      });
    }
  }

  afterInit(server: Server): void {
    // identity is derived server-side at connect; client-asserted userIds
    // in payloads are ignored by every handler below
    server.use(wsAuthMiddleware(this.jwt));
  }

  handleConnection(client: Socket) {
    this.metrics.wsConnectedClients.inc({ namespace: '/' });
    client.emit('connected', {
      id: client.id,
      timestamp: Date.now(),
    });
  }

  async handleDisconnect(client: Socket) {
    this.metrics.wsConnectedClients.dec({ namespace: '/' });
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
      const userId = (client.data as AuthedSocketData).userId;
      this.logger.log({ userId, roomCode: data.roomCode }, 'join');

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

      // Enforce room capacity; a returning participant re-activating never counts
      // against the limit because their slot is already excluded here
      if (room.maxUsers) {
        const otherActive = room.participants.filter(
          (p) => p.user.id !== userId,
        ).length;
        if (otherActive >= room.maxUsers) {
          client.emit('error', { message: 'Room is full' });
          return;
        }
      }

      await client.join(data.roomCode);
      this.userRooms.set(client.id, data.roomCode);
      this.socketToUser.set(client.id, userId);

      // Set room host if first user
      if (!this.roomHosts.has(data.roomCode)) {
        this.roomHosts.set(data.roomCode, userId);
      }

      // Authoritative timeline: hydrate on first touch (paused, P5) and
      // hand the joiner a projectable state instead of a frozen scalar
      const timeline = await this.timeline.ensureRoom(
        data.roomCode,
        room,
        this.clock.now(),
      );

      // P3: the creator returning reclaims control from a promoted stand-in
      const reclaim = this.timeline.reclaim(data.roomCode, userId);
      if (reclaim) {
        this.server.to(data.roomCode).emit(SYNC_EVENTS.controller, {
          v: 1,
          roomCode: data.roomCode,
          ...reclaim,
        });
      }

      // Upsert participant
      const participant = await this.database.participant.upsert({
        where: {
          userId_roomId: {
            userId,
            roomId: room.id,
          },
        },
        update: {
          isActive: true,
          lastPingAt: new Date(),
        },
        create: {
          userId,
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
        timeline,
        participants: updatedParticipants.map((p) => ({
          id: p.user.id,
          username: p.user.username,
        })),
        latency: joinLatency,
      });

      // Log latency for monitoring
      if (joinLatency > 500) {
        this.logger.warn({ joinLatency, userId }, 'high join latency');
      }

      // Notify others with updated participant info
      client.to(data.roomCode).emit('user-joined', {
        userId: participant.user.id,
        username: participant.user.username,
      });

      // Send updated participants list to all users in room (except the joining user)
      client.to(data.roomCode).emit('participants-update', {
        participants: updatedParticipants.map((p) => ({
          id: p.user.id,
          username: p.user.username,
        })),
      });

      // Send chat history to the joining user
      await this.handleGetMessageHistory(client, { roomCode: data.roomCode });
    } catch (error) {
      this.logger.error({ err: String(error) }, 'join failed');
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
        participants: participants.map((p) => ({
          id: p.user.id,
          username: p.user.username,
        })),
      });
    } catch (error) {
      console.error('Error fetching participants:', error);
    }
  }

  @SubscribeMessage(SYNC_EVENTS.clock)
  handleSyncClock(@MessageBody() data: ClockPing): ClockPong {
    // ack fast-path, stamped in the store clock domain (D6): with Redis the
    // timeline is stamped from redis TIME, and t1/t2 must live in that same
    // domain or inter-instance wall-clock skew becomes phantom drift
    const t1 = this.clock.now();
    return { t0: data.t0, t1, t2: this.clock.now() };
  }

  @SubscribeMessage(SYNC_EVENTS.control)
  async handleSyncControl(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: SyncControl,
  ) {
    const stop = this.metrics.wsHandlerDuration.startTimer({
      event: 'sync:control',
    });
    this.metrics.wsEventsReceived.inc({ event: 'sync:control' });
    // never let an unvalidated client string reach the timeline `reason`
    // field or a Prometheus label (unbounded label cardinality is a DoS)
    if (
      !CONTROL_INTENTS.includes(data?.intent) ||
      typeof data.mediaTime !== 'number' ||
      !Number.isFinite(data.mediaTime) ||
      data.mediaTime < 0
    ) {
      client.emit(SYNC_EVENTS.controlRejected, {
        v: 1,
        roomCode: data?.roomCode,
        intent: data?.intent,
        reason: 'room-not-found',
      });
      stop();
      return;
    }
    const userId = (client.data as AuthedSocketData).userId;
    // membership, not just authentication: without this any authenticated
    // socket could drive a guest-control room it never joined
    if (this.userRooms.get(client.id) !== data.roomCode) {
      this.metrics.controlEvents.inc({
        type: data.intent,
        result: 'rejected_not_in_room',
      });
      client.emit(SYNC_EVENTS.controlRejected, {
        v: 1,
        roomCode: data.roomCode,
        intent: data.intent,
        reason: 'not-controller',
      });
      stop();
      return;
    }
    const result = await this.timeline.handleControl(
      data.roomCode,
      client.id,
      userId,
      data.intent,
      data.mediaTime,
      this.clock.now(),
    );
    if (!result.ok) {
      this.metrics.controlEvents.inc({
        type: data.intent,
        result: `rejected_${result.reason.replace(/-/g, '_')}`,
      });
      client.emit(SYNC_EVENTS.controlRejected, {
        v: 1,
        roomCode: data.roomCode,
        intent: data.intent,
        reason: result.reason,
      });
      stop();
      return;
    }
    if (result.timeline === null) {
      // actor plane: the room's owner instance commits and broadcasts
      this.metrics.controlEvents.inc({
        type: data.intent,
        result: 'forwarded',
      });
      stop();
      return;
    }
    this.metrics.controlEvents.inc({ type: data.intent, result: 'accepted' });
    const fanout =
      this.server.sockets.adapter.rooms.get(data.roomCode)?.size ?? 0;
    this.metrics.wsBroadcastFanout.observe(fanout);
    // wait-for-broadcast semantics: the commander applies its own intent
    // from this same message, so every client converges on identical state
    this.server.to(data.roomCode).emit(SYNC_EVENTS.timeline, result.timeline);
    stop();
  }

  /**
   * Repair channel: a periodic re-anchored snapshot per playing room. Late
   * or lossy deliveries self-heal within one sweep period; clients drop
   * stale (storeEpoch, seq) so redundancy is harmless.
   *
   * Only one instance COMMITS per window (the store dedups), but every
   * instance still re-anchors its own local sockets. See `sweepSnapshot`:
   * skipping the broadcast on the losing instances would route their
   * clients' repair through the pub/sub adapter, whose failure is precisely
   * what this sweep is here to repair.
   */
  @Interval(SWEEP_INTERVAL_MS)
  async sweepTimelines() {
    const activeRooms = new Set(this.userRooms.values());
    this.metrics.wsRoomsActive.set(activeRooms.size);
    for (const roomCode of activeRooms) {
      try {
        const snap = await this.timeline.sweepSnapshot(
          roomCode,
          this.clock.now(),
        );
        if (snap.kind === 'committed') {
          this.server.to(roomCode).emit(SYNC_EVENTS.timeline, snap.timeline);
        } else if (snap.kind === 'deferred') {
          // `.local` delivers in-process only: no second adapter publish, so
          // this costs nothing on the wire between instances
          this.server.local
            .to(roomCode)
            .emit(SYNC_EVENTS.timeline, snap.timeline);
        }
      } catch (error) {
        this.logger.error({ err: String(error), roomCode }, 'sweep failed');
      }
    }
  }

  @SubscribeMessage('send-message')
  async handleChatMessage(
    @ConnectedSocket() client: Socket,
    @MessageBody()
    data: {
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

      const formattedMessages = messages.reverse().map((msg) => ({
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

  private async handleLeaveRoom(client: Socket, roomCode: string) {
    try {
      const userId = this.socketToUser.get(client.id);

      await client.leave(roomCode);
      this.userRooms.delete(client.id);
      this.socketToUser.delete(client.id);

      this.timeline.dropSocket(client.id);

      const roomSockets = await this.server.in(roomCode).fetchSockets();
      if (roomSockets.length === 0) {
        this.roomHosts.delete(roomCode);
        await this.timeline.releaseRoom(roomCode);
      } else if (userId) {
        // P3: if a controller left, promote the longest-connected participant
        // (server-derived connect times; the timeline keeps running either way)
        const candidate = roomSockets
          .map((sock) => {
            const sockData = sock.data as Partial<AuthedSocketData>;
            return {
              userId: sockData.userId,
              connectedAt: sockData.connectedAt ?? Infinity,
            };
          })
          .filter((x) => x.userId)
          .sort((a, b) => a.connectedAt - b.connectedAt)[0];
        const change = this.timeline.succession(
          roomCode,
          userId,
          candidate?.userId ?? null,
        );
        if (change) {
          this.server.to(roomCode).emit(SYNC_EVENTS.controller, {
            v: 1,
            roomCode,
            ...change,
          });
        }
        // legacy map bookkeeping
        if (this.roomHosts.get(roomCode) === userId && candidate?.userId) {
          this.roomHosts.set(roomCode, candidate.userId);
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
          participants: remainingParticipants.map((p) => ({
            id: p.user.id,
            username: p.user.username,
          })),
        });
      }
    } catch (error) {
      this.logger.error({ err: String(error) }, 'leave failed');
    }
  }
}
