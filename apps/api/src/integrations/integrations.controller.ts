import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IntegrationProvider } from '@prisma/client';
import type { IntegrationOpenPlatform } from '@tvwatch/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  EmbyConnectDto,
  JellyfinConnectDto,
  PlexServerSelectDto,
  UpdateIntegrationSettingsRequestDto,
} from './dto/integration.dto';
import { IntegrationsService } from './integrations.service';

function provider(raw: string): IntegrationProvider {
  const value = raw?.toUpperCase();
  if (
    value === 'SIMKL' ||
    value === 'STREMIO' ||
    value === 'JELLYFIN' ||
    value === 'PLEX' ||
    value === 'EMBY'
  )
    return value;
  throw new BadRequestException('Unsupported integration provider');
}

function openPlatform(raw?: string): IntegrationOpenPlatform {
  return raw === 'ios' || raw === 'android' ? raw : 'web';
}

@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  list(@CurrentUser('id') userId: string) {
    return this.integrations.list(userId);
  }

  @Post('jellyfin/connect')
  connectJellyfin(@CurrentUser('id') userId: string, @Body() dto: JellyfinConnectDto) {
    return this.integrations.connectJellyfin(userId, dto);
  }

  @Post('emby/connect')
  connectEmby(@CurrentUser('id') userId: string, @Body() dto: EmbyConnectDto) {
    return this.integrations.connectEmby(userId, dto);
  }

  @Post('plex/server')
  selectPlexServer(@CurrentUser('id') userId: string, @Body() dto: PlexServerSelectDto) {
    return this.integrations.selectPlexServer(userId, dto.machineIdentifier);
  }

  @Post('foreground-sync')
  foregroundSync(@CurrentUser('id') userId: string) {
    return this.integrations.syncForeground(userId);
  }

  @Get('media/:mediaId/open-targets')
  mediaOpenTargets(
    @CurrentUser('id') userId: string,
    @Param('mediaId') mediaId: string,
    @Query('platform') platform?: string,
  ) {
    return this.integrations.mediaOpenTargets(userId, mediaId, openPlatform(platform));
  }

  @Post(':provider/link')
  startLink(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.startLink(userId, provider(raw));
  }

  @Post(':provider/link/complete')
  completeLink(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.completeLink(userId, provider(raw));
  }

  @Post(':provider/sync')
  sync(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.sync(userId, provider(raw), { manualOverride: true });
  }

  @Patch(':provider/settings')
  updateSettings(
    @CurrentUser('id') userId: string,
    @Param('provider') raw: string,
    @Body() dto: UpdateIntegrationSettingsRequestDto,
  ) {
    return this.integrations.updateSettings(userId, provider(raw), dto);
  }

  @Post(':provider/items/disable')
  disableItems(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.disableItems(userId, provider(raw));
  }

  @Post(':provider/items/enable')
  enableItems(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.enableItems(userId, provider(raw));
  }

  @Delete(':provider/items')
  deleteSyncedItems(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.deleteSyncedItems(userId, provider(raw));
  }

  @Delete(':provider')
  disconnect(@CurrentUser('id') userId: string, @Param('provider') raw: string) {
    return this.integrations.disconnect(userId, provider(raw));
  }
}
