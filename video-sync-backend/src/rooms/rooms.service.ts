import { Injectable, NotFoundException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { SyncGateway } from '../sync/sync.gateway';

@Injectable()
export class RoomsService {
  constructor(
    private database: DatabaseService,
    private syncGateway: SyncGateway
  ) {}

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

  async updateRoom(roomId: string, data: { name?: string; videoUrl?: string; isPublic?: boolean; maxUsers?: number; isActive?: boolean; isPaused?: boolean }) {
    return await this.database.room.update({
      where: { id: roomId },
      data,
    });
  }

  async pauseRoom(roomId: string, creatorId: string) {
    // Verify the user is the creator of the room
    const room = await this.database.room.findUnique({
      where: { id: roomId },
      select: { creatorId: true, isActive: true, code: true }
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.creatorId !== creatorId) {
      throw new Error('Only the room creator can pause the room');
    }

    if (!room.isActive) {
      throw new Error('Room is already inactive');
    }

    // Pause the room and kick all participants
    await this.database.$transaction(async (tx) => {
      // Set room as paused
      await tx.room.update({
        where: { id: roomId },
        data: { 
          isPaused: true,
          isPlaying: false // Pause the video
        }
      });

      // Kick all participants by setting them as inactive
      await tx.participant.updateMany({
        where: { 
          roomId: roomId,
          isActive: true 
        },
        data: { 
          isActive: false,
          leftAt: new Date()
        }
      });
    });

    // Notify WebSocket gateway to kick participants
    await this.syncGateway.handleRoomStateChange(room.code, 'pause');

    return { success: true, message: 'Room paused successfully' };
  }

  async endRoom(roomId: string, creatorId: string) {
    // Verify the user is the creator of the room
    const room = await this.database.room.findUnique({
      where: { id: roomId },
      select: { creatorId: true, isActive: true, code: true }
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.creatorId !== creatorId) {
      throw new Error('Only the room creator can end the room');
    }

    if (!room.isActive) {
      throw new Error('Room is already inactive');
    }

    // End the room completely
    await this.database.$transaction(async (tx) => {
      // Set room as inactive
      await tx.room.update({
        where: { id: roomId },
        data: { 
          isActive: false,
          isPaused: false,
          isPlaying: false
        }
      });

      // Kick all participants
      await tx.participant.updateMany({
        where: { 
          roomId: roomId,
          isActive: true 
        },
        data: { 
          isActive: false,
          leftAt: new Date()
        }
      });
    });

    // Notify WebSocket gateway to kick participants and clean up
    await this.syncGateway.handleRoomStateChange(room.code, 'end');

    return { success: true, message: 'Room ended successfully' };
  }

  async resumeRoom(roomId: string, creatorId: string) {
    // Verify the user is the creator of the room
    const room = await this.database.room.findUnique({
      where: { id: roomId },
      select: { creatorId: true, isActive: true, isPaused: true, code: true }
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.creatorId !== creatorId) {
      throw new Error('Only the room creator can resume the room');
    }

    if (!room.isActive) {
      throw new Error('Room is inactive and cannot be resumed');
    }

    if (!room.isPaused) {
      throw new Error('Room is not paused');
    }

    // Resume the room
    await this.database.room.update({
      where: { id: roomId },
      data: { 
        isPaused: false
      }
    });

    // Notify WebSocket gateway that room is resumed
    await this.syncGateway.handleRoomStateChange(room.code, 'resume');

    return { success: true, message: 'Room resumed successfully' };
  }

  async getPublicRooms(filter?: string) {
    const where: any = {
      isPublic: true,
      isActive: true,
      isPaused: false, // Don't show paused rooms in public list
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