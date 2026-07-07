import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import configuration from './config/configuration';
import { envValidation } from './config/env-validation';
import { HealthController } from './health.controller';

import { PrismaModule } from './common/prisma/prisma.module';
import { RedisModule } from './common/redis/redis.module';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { MediaMetadataModule } from './media-metadata/media-metadata.module';
import { TrackingModule } from './tracking/tracking.module';
import { CollectionsModule } from './collections/collections.module';
import { ShowsModule } from './shows/shows.module';
import { MoviesModule } from './movies/movies.module';
import { LibraryModule } from './library/library.module';
import { StatsModule } from './stats/stats.module';
import { NotificationsModule } from './notifications/notifications.module';
import { BadgesModule } from './badges/badges.module';
import { SocialModule } from './social/social.module';
import { ListsModule } from './lists/lists.module';
import { ImportModule } from './import/import.module';
import { CommentImageModule } from './comment-images/comment-image.module';
import { AdminModule } from './admin/admin.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [
        // when running compiled (apps/api/dist) -> workspace root .env
        path.resolve(__dirname, '../../../.env'),
        // when running scripts from the api package dir
        path.resolve(process.cwd(), '../../.env'),
        path.resolve(process.cwd(), '.env'),
      ],
      load: [configuration],
      validationSchema: envValidation.validationSchema,
      validationOptions: { ...envValidation },
    }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: true }),
    PrismaModule,
    RedisModule,
    AuthModule,
    UsersModule,
    MediaMetadataModule,
    TrackingModule,
    CollectionsModule,
    ShowsModule,
    MoviesModule,
    LibraryModule,
    StatsModule,
    NotificationsModule,
    BadgesModule,
    SocialModule,
    ListsModule,
    ImportModule,
    CommentImageModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
  ],
})
export class AppModule {}
