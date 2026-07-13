import { Module } from '@nestjs/common';
import { NotificationsController } from './notifications.controller';
import { NotificationService } from './notification.service';
import { PushService } from './push.service';
import { NotificationScheduler } from './notification.scheduler';
import { AnnouncementService } from './announcement.service';
import { BroadcastService } from './broadcast.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Module({
  imports: [MediaMetadataModule],
  controllers: [NotificationsController],
  providers: [NotificationService, PushService, NotificationScheduler, AnnouncementService, BroadcastService],
  exports: [NotificationService, NotificationScheduler, AnnouncementService, BroadcastService],
})
export class NotificationsModule {}
