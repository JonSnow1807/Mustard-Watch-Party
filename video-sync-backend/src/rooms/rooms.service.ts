import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SyncGateway } from '../sync/sync.gateway';
import { Prisma } from '@prisma/client';

@Injectable()
export class RoomsService {
  constructor(
    private database: DatabaseService,
    private sync: SyncGateway,
  ) {}

  async createRoom(
    userId: string,
    name: string,
    videoUrl?: string,
    isPublic?: boolean,
    description?: string,
    tags?: string[],
    allowGuestControl?: boolean,
  ) {
    const room = await this.database.room.create({
      data: {
        name,
        videoUrl,
        creatorId: userId,
        isPublic: isPublic || false,
        description,
        tags: tags || [],
        allowGuestControl: allowGuestControl || false,
      },
    });

    return room;
  }

  async getRoomByCode(code: string) {
    const room = await this.database.room.findUnique({
      where: { code },
      // Narrowed on purpose, and the narrowing is load-bearing. Prisma
      // returns EVERY scalar of a relation pulled with `creator: true` -
      // and User.password is a scalar, so that shape served the creator's
      // bcrypt hash to any caller holding a room code, unauthenticated,
      // in production. Participant emails went the same way. Nothing
      // renders either field: the UI shows a host name and participant
      // names. rooms.service.spec.ts fails if this ever widens again.
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
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

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    return room;
  }

  /**
   * Ownership-checked PATCH path, the mirror of deleteRoom. Every method
   * here takes the caller's id explicitly and the CONTROLLER supplies the
   * one it got from the verified token - the id is never read off the body.
   *
   * PATCH shipped for months with no check at all: any caller who knew a
   * code could rename someone's room or repoint its video.
   */
  async updateRoomByCode(
    code: string,
    userId: string,
    // Every field here reaches Prisma verbatim, so this list has to match
    // UpdateRoomDto. It said name/videoUrl while three more columns were
    // already flowing through - TypeScript allows the extra properties
    // because the caller passes a variable rather than a literal, so the
    // signature was quietly wrong rather than loudly.
    data: {
      name?: string;
      videoUrl?: string;
      isPublic?: boolean;
      allowGuestControl?: boolean;
      maxUsers?: number;
    },
  ) {
    const room = await this.database.room.findUnique({
      where: { code },
      select: { id: true, creatorId: true },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the room creator can update this room',
      );
    }

    return await this.updateRoom(room.id, data);
  }

  /**
   * Unchecked by design and by id, not code: the only caller is
   * updateRoomByCode, which does the ownership check. Nothing that faces a
   * request should call this directly.
   */
  private async updateRoom(
    roomId: string,
    data: { name?: string; videoUrl?: string },
  ) {
    return await this.database.room.update({
      where: { id: roomId },
      data,
    });
  }

  async deleteRoom(code: string, userId: string) {
    // First, get the room to check if it exists and verify ownership
    const room = await this.database.room.findUnique({
      where: { code },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
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

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    // Check if the user is the creator of the room
    if (room.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the room creator can delete this room',
      );
    }

    // Told BEFORE the row disappears, not after: once it is gone, a client
    // that reacts by refetching gets a 404 and shows "couldn't load the
    // room" instead of "the host ended it". The announcement is the last
    // thing this room says, so it should still be able to say it.
    this.sync.announceRoomClosed(code);

    // Delete all related data first (due to foreign key constraints)
    await this.database.$transaction(async (prisma) => {
      // Delete chat messages
      await prisma.chatMessage.deleteMany({
        where: { roomId: room.id },
      });

      // Delete sync events
      await prisma.syncEvent.deleteMany({
        where: { roomId: room.id },
      });

      // Delete participants
      await prisma.participant.deleteMany({
        where: { roomId: room.id },
      });

      // Finally, delete the room
      await prisma.room.delete({
        where: { id: room.id },
      });
    });

    return {
      message: 'Room deleted successfully',
      deletedRoom: {
        id: room.id,
        name: room.name,
        code: room.code,
      },
    };
  }

  async getPublicRooms(filter?: string) {
    const where: Prisma.RoomWhereInput = {
      isPublic: true,
      isActive: true,
    };

    if (filter && filter !== 'all') {
      where.tags = {
        has: filter,
      };
    }

    const rooms = await this.database.room.findMany({
      where,
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        _count: {
          select: {
            participants: {
              where: { isActive: true },
            },
          },
        },
      },
      orderBy: [
        { isPlaying: 'desc' }, // Show live rooms first
        { updatedAt: 'desc' },
      ],
      take: 20,
    });

    return rooms;
  }

  async getUserRooms(userId: string) {
    const rooms = await this.database.room.findMany({
      where: {
        OR: [
          { creatorId: userId },
          {
            participants: {
              some: {
                userId,
                isActive: true,
              },
            },
          },
        ],
      },
      include: {
        creator: {
          select: {
            id: true,
            username: true,
          },
        },
        _count: {
          select: {
            participants: {
              where: { isActive: true },
            },
          },
        },
      },
      orderBy: {
        updatedAt: 'desc',
      },
    });

    return rooms;
  }
}
