import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RolesGuard } from './roles.guard';
import { CronManagerService } from './cron-manager.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProviderAlertsModule } from '../provider-alerts/provider-alerts.module';
import { SocialModule } from '../social/social.module';
import { ContactModule } from '../contact/contact.module';
import { UsersModule } from '../users/users.module';
import { ImportModule } from '../import/import.module';
import { AdminImportService } from './admin-import.service';

@Module({
  imports: [
    MediaMetadataModule,
    NotificationsModule,
    ProviderAlertsModule,
    ScheduleModule,
    SocialModule,
    ContactModule,
    UsersModule,
    ImportModule,
  ],
  controllers: [AdminController],
  providers: [AdminService, AdminImportService, RolesGuard, CronManagerService],
  exports: [RolesGuard],
})
export class AdminModule {}
