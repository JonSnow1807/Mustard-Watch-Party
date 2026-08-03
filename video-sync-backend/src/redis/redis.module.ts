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

function makeClient(url: string, kind: 'kv' | 'pubsub'): Redis {
  return new Redis(url, {
    retryStrategy: (times) => Math.min(times * 200, 5000),
    // KV fails fast: a control event against a down Redis should reject
    // (client gets a typed error), not queue forever. Pub/sub clients must
    // queue - the adapter subscribes during connection setup, and dropped
    // subscriptions would silently kill cross-instance fanout.
    ...(kind === 'kv'
      ? { maxRetriesPerRequest: 2, enableOfflineQueue: false }
      : { maxRetriesPerRequest: null, enableOfflineQueue: true }),
  });
}

const factory = (kind: symbol, clientKind: 'kv' | 'pubsub') => ({
  provide: kind,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Redis | null => {
    const url = config.get<string>('redis.url') ?? process.env.REDIS_URL;
    if (!url) return null;
    return makeClient(url, clientKind);
  },
});

@Global()
@Module({
  providers: [
    factory(REDIS_KV, 'kv'),
    factory(REDIS_PUB, 'pubsub'),
    factory(REDIS_SUB, 'pubsub'),
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
