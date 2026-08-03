// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SyncGateway } from './sync.gateway';
import { VoiceGateway } from './voice.gateway';
import { SyncService } from './sync.service';
import { TimelineService } from './timeline.service';
import { InMemoryRoomStateStore, ROOM_STATE_STORE } from './room-state.store';

@Module({
  imports: [AuthModule],
  providers: [
    SyncGateway,
    VoiceGateway,
    SyncService,
    TimelineService,
    // M6 swaps this provider for the Redis/Lua implementation
    { provide: ROOM_STATE_STORE, useClass: InMemoryRoomStateStore },
  ],
  exports: [SyncService],
})
export class SyncModule {}
