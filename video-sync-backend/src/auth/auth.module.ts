// src/auth/auth.module.ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { GoogleOAuthService } from './google/google-oauth.service';
import { GuestSweeperService } from './guest-sweeper.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('jwt.secret'),
        // verified at connect only; an accepted socket outlives its token
        // (documented limitation - no refresh/revocation in scope)
        signOptions: { expiresIn: '12h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleOAuthService, GuestSweeperService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
