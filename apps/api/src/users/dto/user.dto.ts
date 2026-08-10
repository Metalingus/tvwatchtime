import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MediaType } from '@prisma/client';
import { MEDIA_TAG_SLUGS } from '@tvwatch/shared';
import { Type } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class ExploreDefaultFiltersDto {
  @IsOptional()
  @IsString()
  genre!: string | null;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  excludeGenres!: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsIn([...MEDIA_TAG_SLUGS], { each: true })
  tags?: string[];

  @IsIn(['popularity', 'releaseDate'])
  order!: 'popularity' | 'releaseDate';

  @IsIn(['both', 'movies', 'shows'])
  mediaType!: 'both' | 'movies' | 'shows';

  @IsOptional()
  @IsString()
  country!: string | null;

  @IsBoolean()
  hideAnime!: boolean;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  hideAnimeInExplore?: boolean;

  @ApiPropertyOptional({ type: ExploreDefaultFiltersDto, nullable: true })
  @ValidateIf((_, value) => value !== undefined && value !== null)
  @ValidateNested()
  @Type(() => ExploreDefaultFiltersDto)
  exploreDefaultFilters?: ExploreDefaultFiltersDto | null;

  @ApiPropertyOptional({ enum: ['system', 'light', 'dark'] })
  @IsOptional()
  @IsString()
  themePreference?: string;

  @ApiPropertyOptional({
    enum: [
      'system',
      'en',
      'fr',
      'es',
      'pt-BR',
      'de',
      'it',
      'ar',
      'tr',
      'hi',
      'id',
      'ja',
      'ko',
      'zh-CN',
    ],
  })
  @IsOptional()
  @IsString()
  languagePreference?: string;
}

export class DeviceRegisterDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiProperty()
  @IsString()
  platform!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  appVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pushEndpoint?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pushP256dh?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pushAuth?: string;
}

export class PublicUserQueryDto {
  @ApiPropertyOptional({ enum: MediaType })
  @IsOptional()
  @IsEnum(MediaType)
  type?: MediaType;
}
