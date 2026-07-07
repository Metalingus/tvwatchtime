import { Module } from '@nestjs/common';
import { BadgesController } from './badges.controller';
import { BadgeService } from './badge.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [NotificationsModule],
  controllers: [BadgesController],
  providers: [BadgeService],
})
export class BadgesModule {}
