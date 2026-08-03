import { Controller, Get, Inject, Optional } from '@nestjs/common';
import type Redis from 'ioredis';
import { AppService } from './app.service';
import { REDIS_KV } from './redis/redis.module';

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    @Optional() @Inject(REDIS_KV) private readonly redis: Redis | null,
  ) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  async getHealth(): Promise<{
    status: 'ok' | 'degraded';
    redis: 'ok' | 'down' | 'disabled';
    timestamp: string;
  }> {
    // degraded (not dead) when Redis is unreachable: REST still works and
    // clients keep playing their last timeline, but control events fail fast
    let redis: 'ok' | 'down' | 'disabled' = 'disabled';
    if (this.redis) {
      try {
        await this.redis.ping();
        redis = 'ok';
      } catch {
        redis = 'down';
      }
    }
    return {
      status: redis === 'down' ? 'degraded' : 'ok',
      redis,
      timestamp: new Date().toISOString(),
    };
  }
}
