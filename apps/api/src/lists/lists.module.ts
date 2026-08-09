import { Module } from '@nestjs/common';
import { ListsController } from './lists.controller';
import { ListsService } from './lists.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Module({
  imports: [NotificationsModule, MediaMetadataModule],
  controllers: [ListsController],
  providers: [ListsService],
})
export class ListsModule {}
