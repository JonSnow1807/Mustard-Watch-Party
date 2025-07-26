// src/sync/sync.module.ts
import { Module } from '@nestjs/common';
import { SyncGateway } from './sync.gateway';
import { SyncService } from './sync.service';

@Module({
  providers: [SyncGateway, SyncService],
  exports: [SyncService],
})
export class SyncModule {}
