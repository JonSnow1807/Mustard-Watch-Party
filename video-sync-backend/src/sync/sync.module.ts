// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SyncGateway } from './sync.gateway';
import { VoiceGateway } from './voice.gateway';
import { SyncService } from './sync.service';
import { TimelineService } from './timeline.service';
import { InMemoryRoomStateStore, ROOM_STATE_STORE } from './room-state.store';
import { RedisRoomStateStore } from './redis-room-state.store';
import { redisEnabled } from '../redis/redis.module';

@Module({
  imports: [AuthModule],
  providers: [
    SyncGateway,
    VoiceGateway,
    SyncService,
    TimelineService,
    // Redis/Lua store when REDIS_URL is set (multi-instance correctness);
    // in-memory otherwise (single instance, CI protocol-only mode)
    {
      provide: ROOM_STATE_STORE,
      useClass: redisEnabled() ? RedisRoomStateStore : InMemoryRoomStateStore,
    },
  ],
  exports: [SyncService],
})
export class SyncModule {}
