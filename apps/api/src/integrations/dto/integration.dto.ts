import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import type { UpdateIntegrationSettingsDto } from '@tvwatch/shared';

export class JellyfinConnectDto {
  @ApiProperty({ example: 'https://jellyfin.example.com' })
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(2048)
  serverUrl!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  username!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1000)
  password!: string;
}

class IntegrationMediaSyncSettingsDto {
  @IsOptional()
  @IsBoolean()
  watched?: boolean;

  @IsOptional()
  @IsBoolean()
  watchlist?: boolean;

  @IsOptional()
  @IsBoolean()
  favorites?: boolean;

  @IsOptional()
  @IsBoolean()
  ratings?: boolean;
}

class IntegrationSyncSettingsDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => IntegrationMediaSyncSettingsDto)
  movies?: IntegrationMediaSyncSettingsDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => IntegrationMediaSyncSettingsDto)
  shows?: IntegrationMediaSyncSettingsDto;
}

export class UpdateIntegrationSettingsRequestDto implements UpdateIntegrationSettingsDto {
  @IsOptional()
  @IsBoolean()
  paused?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => IntegrationSyncSettingsDto)
  syncSettings?: IntegrationSyncSettingsDto;
}
