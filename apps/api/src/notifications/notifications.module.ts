import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationService } from './notification.service';
import { PushService } from './push.service';
import { NotificationScheduler } from './notification.scheduler';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Module({
  imports: [MediaMetadataModule],
  controllers: [NotificationsController],
  providers: [NotificationService, PushService, NotificationScheduler],
  exports: [NotificationService, NotificationScheduler],
})
export class NotificationsModule {}
