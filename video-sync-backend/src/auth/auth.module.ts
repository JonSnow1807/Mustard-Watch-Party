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
        // Read from config rather than hardcoded. It was hardcoded to '12h'
        // while configuration.ts carried a JWT_EXPIRES_IN of '7d' that
        // nothing read - so the documented knob did nothing and the two
        // disagreed by a factor of fourteen.
        //
        // 12h is now the DEFAULT rather than the lifetime: a deployment that
        // sets JWT_EXPIRES_IN changes it, which is the whole point of making
        // this live. Unset, nothing about the behaviour changed.
        //
        // Still verified at connect only; an accepted socket outlives its
        // token (documented limitation - no refresh/revocation in scope).
        signOptions: {
          expiresIn: config.get<string>('jwt.expiresIn') ?? '12h',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, GoogleOAuthService, GuestSweeperService],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
