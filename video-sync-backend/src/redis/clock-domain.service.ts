import {
  Inject,
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { REDIS_KV } from './redis.module';

/**
 * D6 — one clock domain across instances. With Redis, every timeline is
 * stamped from redis TIME inside the store's Lua scripts; anything the
 * instance itself stamps into that domain (the sync:clock ack's t1/t2)
 * must be converted through this smoothed local→Redis offset, or
 * inter-instance wall-clock skew would masquerade as playback drift.
 * Without Redis (single instance / CI), the offset is identically zero.
 */
@Injectable()
export class ClockDomainService implements OnModuleInit, OnApplicationShutdown {
  private offsetMs = 0;
  private samples: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(@Optional() @Inject(REDIS_KV) private redis: Redis | null) {}

  async onModuleInit(): Promise<void> {
    if (!this.redis) return;
    await this.measure().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.measure().catch(() => undefined);
    }, 5000);
  }

  private async measure(): Promise<void> {
    if (!this.redis) return;
    const tA = Date.now();
    const [sec, usec] = await this.redis.time();
    const tB = Date.now();
    const redisNow = Number(sec) * 1000 + Number(usec) / 1000;
    const sample = redisNow - (tA + tB) / 2;
    this.samples.push(sample);
    if (this.samples.length > 8) this.samples.shift();
    // EMA-8 over round-trip midpoints; sub-ms on LAN
    this.offsetMs =
      this.samples.reduce((s, x) => s + x, 0) / this.samples.length;
  }

  /** Current time in the authoritative (store) clock domain, ms. */
  now(): number {
    return Date.now() + this.offsetMs;
  }

  getOffsetMs(): number {
    return this.offsetMs;
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
