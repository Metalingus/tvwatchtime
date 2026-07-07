import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';

export const IMPORT_ITEM_STATUSES = [
  'matched',
  'unmatched',
  'duplicate',
  'conflict',
  'invalid',
  'needs_review',
  'skipped',
  'applied',
] as const;
export type ImportItemStatusFilter = (typeof IMPORT_ITEM_STATUSES)[number];

export class ListImportItemsDto {
  @ApiPropertyOptional({ enum: IMPORT_ITEM_STATUSES })
  @IsOptional()
  @IsIn(IMPORT_ITEM_STATUSES)
  status?: ImportItemStatusFilter;

  @ApiPropertyOptional({ description: 'source_entity_type filter, e.g. WATCHLIST_SHOW' })
  @IsOptional()
  @IsString()
  entity?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  page?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  pageSize?: string;
}

export class PatchImportItemDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  matchedMediaId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  userResolution?: 'accept' | 'skip' | 'replace_existing' | 'keep_existing';
}
