import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  
  // Enable CORS
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3001',
    credentials: true,
  });
  
  // Enable validation
  app.useGlobalPipes(new ValidationPipe());
  
  // Set global prefix
  app.setGlobalPrefix('api', { exclude: [''] });
  
  // Performance monitoring middleware
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (duration > 100) { // Log slow requests
        console.log(`⚠️  Slow: ${req.method} ${req.url} - ${duration}ms`);
      }
    });
    next();
  });
  
  const port = process.env.PORT || 3000;
  await app.listen(port);
  
  console.log(`🚀 Server is running on http://localhost:${port}`);
  console.log(`🔌 WebSocket server is ready for connections`);
  console.log(`📊 Expecting <500ms sync latency`);
}
bootstrap();