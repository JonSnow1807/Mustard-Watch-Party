// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { SyncGateway } from './sync.gateway';
import { VoiceGateway } from './voice.gateway';
import { SyncService } from './sync.service';

@Module({
  providers: [SyncGateway, VoiceGateway, SyncService],
  exports: [SyncService],
})
export class SyncModule {}
