import { INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';
import { REDIS_PUB, REDIS_SUB } from '../redis/redis.module';

/**
 * Cross-instance fanout: the default in-memory adapter is swapped for the
 * Redis pub/sub adapter when REDIS_URL is set. Applies to every namespace
 * (/ and /voice). Pub/sub loss during a Redis blip self-heals within one
 * 10s snapshot sweep - the sweep is the repair channel by design.
 */
export class RedisIoAdapter extends IoAdapter {
  private pub: Redis;
  private sub: Redis;

  constructor(app: INestApplication) {
    super(app);
    this.pub = app.get<Redis>(REDIS_PUB);
    this.sub = app.get<Redis>(REDIS_SUB);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as {
      adapter: (a: unknown) => void;
    };
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }
}
