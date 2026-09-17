import { CommsUniBackfillService } from './commsuni.backfill.service';
import { Global, Module } from '@nestjs/common';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { CommsUniVotingService } from './commsuni.voting.service';
import { CommsUniClient } from './commsuni.client';
import { CommsUniResolver } from './commsuni.resolver';
import { CommsUniReadService } from './commsuni.read.service';
import { CommsUniPublicationService } from './commsuni.publication.service';
import { CommsUniAdminController } from './commsuni.admin.controller';

@Global()
@Module({
  imports: [MediaMetadataModule],
  controllers: [CommsUniAdminController],
  providers: [
    CommsUniClient,
    CommsUniResolver,
    CommsUniReadService,
    CommsUniPublicationService,
    CommsUniVotingService,
    CommsUniBackfillService,
  ],
  exports: [
    CommsUniClient,
    CommsUniResolver,
    CommsUniReadService,
    CommsUniPublicationService,
    CommsUniVotingService,
  ],
})
export class CommsUniModule {}
