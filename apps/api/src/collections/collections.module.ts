import { Global, Module } from '@nestjs/common';
import { CollectionsController } from './collections.controller';
import { CollectionsService } from './collections.service';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';

@Global()
@Module({
  imports: [MediaMetadataModule],
  controllers: [CollectionsController],
  providers: [CollectionsService],
  exports: [CollectionsService],
})
export class CollectionsModule {}
