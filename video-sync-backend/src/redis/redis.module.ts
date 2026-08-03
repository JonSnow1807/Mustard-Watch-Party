import { Global, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ClockDomainService } from './clock-domain.service';

export const REDIS_KV = Symbol('REDIS_KV');
export const REDIS_PUB = Symbol('REDIS_PUB');
export const REDIS_SUB = Symbol('REDIS_SUB');

export function redisEnabled(): boolean {
  return Boolean(process.env.REDIS_URL);
}

function makeClient(url: string): Redis {
  return new Redis(url, {
    // capped backoff; control events fail fast rather than queueing forever
    retryStrategy: (times) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
}

const factory = (kind: symbol) => ({
  provide: kind,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    const url = config.get<string>('redis.url') ?? process.env.REDIS_URL;
    if (!url) return null;
    return makeClient(url);
  },
});

@Global()
@Module({
  providers: [
    factory(REDIS_KV),
    factory(REDIS_PUB),
    factory(REDIS_SUB),
    ClockDomainService,
  ],
  exports: [REDIS_KV, REDIS_PUB, REDIS_SUB, ClockDomainService],
})
export class RedisModule implements OnApplicationShutdown {
  constructor() {}

  async onApplicationShutdown(): Promise<void> {
    // clients are quit by ClockDomainService/adapter owners; ioredis also
    // terminates cleanly on process exit
  }
}
