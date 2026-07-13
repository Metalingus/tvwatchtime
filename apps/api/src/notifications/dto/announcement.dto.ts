import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';

/** Per-locale text map: { en: '...', fr: '...', ... }. `en` is required (enforced in service). */
export type LocaleTextDto = Record<string, string>;

export class AnnouncementActionParamsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  showId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  listId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;
}

export class CreateAnnouncementDto {
  @ApiPropertyOptional({ default: 'information-circle-outline' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiProperty({ description: 'Per-locale title; `en` required.' })
  @IsObject()
  title!: LocaleTextDto;

  @ApiProperty({ description: 'Per-locale message; `en` required.' })
  @IsObject()
  message!: LocaleTextDto;

  @ApiPropertyOptional({ description: 'Per-locale CTA label. Omit/null for no CTA.' })
  @IsOptional()
  @IsObject()
  actionLabel?: LocaleTextDto | null;

  @ApiPropertyOptional({
    description:
      'Named target (whitelist). none|import|explore|my-lists|followed-lists|stats|settings|notifications|show|list|external',
  })
  @IsOptional()
  @IsString()
  actionTarget?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementActionParamsDto)
  actionParams?: AnnouncementActionParamsDto;

  @ApiPropertyOptional({ default: 'shows' })
  @IsOptional()
  @IsString()
  placement?: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'Send a broadcast push when activated (one-shot).',
  })
  @IsOptional()
  @IsBoolean()
  alsoPush?: boolean;
}

export class UpdateAnnouncementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  title?: LocaleTextDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  message?: LocaleTextDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  actionLabel?: LocaleTextDto | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actionTarget?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementActionParamsDto)
  actionParams?: AnnouncementActionParamsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  placement?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  alsoPush?: boolean;
}

export class ActivateAnnouncementDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  alsoPush?: boolean;
}

export class CreateBroadcastDto {
  @ApiProperty({ description: 'Per-locale title; `en` required.' })
  @IsObject()
  title!: LocaleTextDto;

  @ApiPropertyOptional({ description: 'Per-locale body.' })
  @IsOptional()
  @IsObject()
  body?: LocaleTextDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actionTarget?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => AnnouncementActionParamsDto)
  actionParams?: AnnouncementActionParamsDto;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  inApp?: boolean;

  @ApiPropertyOptional({ default: 'ANNOUNCEMENT' })
  @IsOptional()
  @IsString()
  category?: string;
}
