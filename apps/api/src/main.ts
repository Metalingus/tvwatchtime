import { ValidationPipe, Logger, LogLevel } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { join } from 'path';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  const verbosity = (config.get<string>('LOG_LEVEL') || 'log').toLowerCase() as LogLevel;
  const order: LogLevel[] = ['verbose', 'debug', 'log', 'warn', 'error'];
  app.useLogger(order.slice(Math.max(0, order.indexOf(verbosity))));

  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(compression());
  app.use(cookieParser());

  // Serve local user images (avatars/covers) as public static files
  // Must match the Docker volume mount: api-storage:/app/apps/api/storage
  app.useStaticAssets(join(process.cwd(), 'apps', 'api', 'storage'), { prefix: '/uploads/' });

  const origins = (config.get<string>('CORS_ORIGINS') || '').split(',').filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : true,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  if (config.get<string>('NODE_ENV') !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('TVWatchTime API')
      .setDescription('TV/movie tracking backend')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swaggerConfig));
  }

  const port = config.get<number>('API_PORT') || 4000;
  await app.listen(port);
  Logger.log(`🚀 API on http://localhost:${port}/api`, 'Bootstrap');
  Logger.log(`📘 Docs on http://localhost:${port}/docs`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', err);
  process.exit(1);
});
