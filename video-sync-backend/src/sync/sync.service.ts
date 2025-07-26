import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class SyncService {
  constructor(private database: DatabaseService) {}

  async getRoomState(roomCode: string) {
    const room = await this.database.room.findUnique({
      where: { code: roomCode },
      select: {
        currentTime: true,
        isPlaying: true,
        lastSyncAt: true,
      },
    });
    
    return room;
  }

  async updateRoomState(roomCode: string, state: { currentTime: number; isPlaying: boolean }) {
    return await this.database.room.update({
      where: { code: roomCode },
      data: {
        ...state,
        lastSyncAt: new Date(),
      },
    });
  }
}
