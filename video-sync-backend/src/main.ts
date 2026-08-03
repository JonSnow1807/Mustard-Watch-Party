import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RedisIoAdapter } from './adapters/redis-io.adapter';
import { redisEnabled } from './redis/redis.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  // Enable CORS; FRONTEND_URL is a comma-separated allowlist so prod can
  // cover the Vercel domain plus preview deployments
  app.enableCors({
    origin: (process.env.FRONTEND_URL || 'http://localhost:3001')
      .split(',')
      .map((o) => o.trim()),
    credentials: true,
  });

  // Enable validation
  app.useGlobalPipes(new ValidationPipe());

  // Multi-instance plane: Redis pub/sub fanout when REDIS_URL is set
  if (redisEnabled()) {
    app.useWebSocketAdapter(new RedisIoAdapter(app));
  }

  // Set global prefix
  app.setGlobalPrefix('api', { exclude: ['', 'health', 'metrics'] });

  // Performance monitoring middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 100) {
        // Log slow requests
        console.log(`⚠️  Slow: ${req.method} ${req.url} - ${duration}ms`);
      }
    });
    next();
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);

  console.log(`🚀 Server is running on port ${port}`);
  console.log(`🔌 WebSocket server is ready for connections`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(
    `🌐 CORS origin: ${process.env.FRONTEND_URL || 'http://localhost:3001'}`,
  );
}
void bootstrap();
