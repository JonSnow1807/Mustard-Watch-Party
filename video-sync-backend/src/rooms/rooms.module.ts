// src/rooms/rooms.module.ts
import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module';
import { AuthModule } from '../auth/auth.module';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

@Module({
  // for JwtService: JwtAuthGuard on the controller's routes is instantiated
  // in THIS module's injector, so the JwtModule AuthModule exports (same
  // secret the WS handshake verifies with) has to be visible here.
  imports: [AuthModule, SyncModule],
  controllers: [RoomsController],
  providers: [RoomsService],
  exports: [RoomsService],
})
export class RoomsModule {}
