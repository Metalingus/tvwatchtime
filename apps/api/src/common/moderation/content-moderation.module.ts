import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ContentModerationService } from './content-moderation.service';

@Module({
  imports: [ConfigModule],
  providers: [ContentModerationService],
  exports: [ContentModerationService],
})
export class ContentModerationModule {}
