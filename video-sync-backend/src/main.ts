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
  app.setGlobalPrefix('api', { exclude: ['', 'health'] });
  
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
  
  console.log(`🚀 Server is running on port ${port}`);
  console.log(`🔌 WebSocket server is ready for connections`);
  console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🌐 CORS origin: ${process.env.FRONTEND_URL || 'http://localhost:3001'}`);
}
bootstrap();