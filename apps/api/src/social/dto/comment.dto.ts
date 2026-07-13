import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentThreadType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

/** Max stored length for a GIPHY media URL. */
export const GIF_URL_MAX_LENGTH = 2048;

/**
 * Validate that a URL is an HTTPS URL hosted by GIPHY-controlled domains.
 * Allows exactly `giphy.com` or any subdomain ending in `.giphy.com`.
 * Rejects data:, file:, javascript:, localhost, private IPs, and other hosts
 * by virtue of the https + host allowlist.
 */
export function isAllowedGiphyUrl(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  if (url.length > GIF_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'giphy.com') return true;
  if (host.endsWith('.giphy.com')) return true;
  return false;
}

export class CreateCommentDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

  @ApiPropertyOptional({ description: 'Final GIPHY media URL (https, *.giphy.com)' })
  @IsOptional()
  @IsString()
  @MaxLength(GIF_URL_MAX_LENGTH)
  gifUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;
}

export class CommentQueryDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  pageSize?: number = 20;
}

export class ReportCommentDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}
