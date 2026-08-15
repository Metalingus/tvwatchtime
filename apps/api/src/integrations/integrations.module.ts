import { Module } from '@nestjs/common';
import { ImportModule } from '../import/import.module';
import { IntegrationCredentialService } from './integration-credential.service';
import { IntegrationDataService } from './integration-data.service';
import { IntegrationImportService } from './integration-import.service';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';
import { JellyfinClient } from './providers/jellyfin.client';
import { EmbyClient } from './providers/emby.client';
import { PlexClient } from './providers/plex.client';
import { SimklClient } from './providers/simkl.client';
import { StremioClient } from './providers/stremio.client';

@Module({
  imports: [ImportModule],
  controllers: [IntegrationsController],
  providers: [
    IntegrationsService,
    IntegrationCredentialService,
    IntegrationDataService,
    IntegrationImportService,
    SimklClient,
    StremioClient,
    JellyfinClient,
    EmbyClient,
    PlexClient,
  ],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
