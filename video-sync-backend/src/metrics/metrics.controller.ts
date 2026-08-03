import {
  Controller,
  Get,
  Headers,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint. Excluded from the /api prefix (main.ts) like
 * /health. Optionally token-gated: it leaks room/connection counts, and the
 * guard is five lines - set METRICS_TOKEN in prod, leave unset in the lab.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private metrics: MetricsService) {}

  @Get()
  async scrape(
    @Res() res: Response,
    @Headers('authorization') auth?: string,
  ): Promise<void> {
    const required = process.env.METRICS_TOKEN;
    if (required && auth !== `Bearer ${required}`) {
      throw new UnauthorizedException();
    }
    res.setHeader('content-type', 'text/plain; version=0.0.4');
    res.send(await this.metrics.metrics());
  }
}
