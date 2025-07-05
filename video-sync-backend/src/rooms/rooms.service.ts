import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class RoomsService {
  constructor(private database: DatabaseService) {}

  async createRoom(userId: string, name: string, videoUrl?: string) {
    const room = await this.database.room.create({
      data: {
        name,
        videoUrl,
        creatorId: userId,
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