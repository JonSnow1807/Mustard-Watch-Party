import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class RoomsService {
  constructor(private database: DatabaseService) {}

  async createRoom(
    userId: string, 
    name: string, 
    videoUrl?: string,
    isPublic?: boolean,
    description?: string,
    tags?: string[]
  ) {
    const room = await this.database.room.create({
      data: {
        name,
        videoUrl,
        creatorId: userId,
        isPublic: isPublic || false,
        description,
        tags: tags || [],
      },
    });

    return room;
  }

  async getRoomByCode(code: string) {
    const room = await this.database.room.findUnique({
      where: { code },
      include: {
        creator: true,
        participants: {
          where: { isActive: true },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
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

  async updateRoom(roomId: string, data: { name?: string; videoUrl?: string }) {
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
      throw new ForbiddenException('Only the room creator can delete this room');
    }

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
    const where: any = {
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