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

  /**
   * Which build is answering.
   *
   * Render sets RENDER_GIT_COMMIT on every deploy. Read once at startup, so
   * this is the commit of the process that is serving - not of whatever the
   * repository happens to be at.
   *
   * This exists because "the service answers /health" does NOT mean a deploy
   * landed: Render builds before it swaps, so the OLD instance answers
   * perfectly for several minutes. A deploy check without a revision to
   * compare against verifies the very build it is replacing.
   */
  private readonly revision =
    process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown';

  @Get('health')
  async getHealth(): Promise<{
    status: 'ok' | 'degraded';
    redis: 'ok' | 'down' | 'disabled';
    revision: string;
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
      revision: this.revision,
      timestamp: new Date().toISOString(),
    };
  }
}
