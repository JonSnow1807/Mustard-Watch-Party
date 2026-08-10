// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { VoiceRosterService } from './voice-roster.service';
import { SyncGateway } from './sync.gateway';
import { VoiceGateway } from './voice.gateway';
import { SyncService } from './sync.service';
import { TimelineService } from './timeline.service';
import { InMemoryRoomStateStore, ROOM_STATE_STORE } from './room-state.store';
import { RedisRoomStateStore } from './redis-room-state.store';
import { ActorRoomStateStore } from './actor-room-state.store';
import { redisEnabled } from '../redis/redis.module';

/**
 * Coordination plane selection (docs/COORDINATION.md):
 *   lua   - shared Redis hash, one Lua script per mutation as the serializer
 *   actor - single-owner room actors with lease fencing (formal/SyncActor.tla)
 * Both require Redis; without it the in-memory single-instance store is used.
 */
function storeClass() {
  if (!redisEnabled()) return InMemoryRoomStateStore;
  return process.env.STORE_MODE === 'actor'
    ? ActorRoomStateStore
    : RedisRoomStateStore;
}

@Module({
  imports: [AuthModule],
  providers: [
    SyncGateway,
    VoiceRosterService,
    VoiceGateway,
    SyncService,
    TimelineService,
    // Redis/Lua store when REDIS_URL is set (multi-instance correctness);
    // in-memory otherwise (single instance, CI protocol-only mode)
    { provide: ROOM_STATE_STORE, useClass: storeClass() },
  ],
  exports: [SyncService, SyncGateway],
})
export class SyncModule {}
