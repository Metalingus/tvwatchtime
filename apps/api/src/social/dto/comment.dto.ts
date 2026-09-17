import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentThreadType, MediaType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  ArrayMaxSize,
  ValidateNested,
  IsBoolean,
  IsEnum,
  IsInt,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  IsDateString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

import { GIF_URL_MAX_LENGTH } from '../../common/utils/gif-url';
export { isAllowedGifUrl } from '../../common/utils/gif-url';

/** Sort order accepted by comment list + reply endpoints. */
export const COMMENT_SORTS = ['LATEST', 'MOST_LIKED'] as const;
export type CommentSort = (typeof COMMENT_SORTS)[number];

class CommsUniMentionInput {
  @IsUUID() authorId!: string;
  @IsInt() @Min(0) start!: number;
  @IsInt() @Min(1) end!: number;
  @IsString() @MaxLength(200) text!: string;
}

export class CreateCommentDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => CommsUniMentionInput)
  commsUniMentions?: CommsUniMentionInput[];

  @IsOptional()
  @IsUUID()
  clientActionId?: string;

  @IsOptional()
  @IsDateString()
  @Matches(/(Z|[+-]\d{2}:\d{2})$/i)
  createdAt?: string;

  @IsOptional()
  @IsBoolean()
  attachmentPending?: boolean;

  @IsOptional()
  @IsUUID()
  commsUniParentId?: string;

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

  @ApiPropertyOptional({ description: 'Public HTTPS GIF media URL (any provider)' })
  @IsOptional()
  @IsString()
  @MaxLength(GIF_URL_MAX_LENGTH)
  gifUrl?: string;

  @ApiPropertyOptional({
    enum: MediaType,
    description: 'Attached show/movie card type. Requires mediaId.',
  })
  @IsOptional()
  @IsEnum(MediaType)
  mediaType?: MediaType;

  @ApiPropertyOptional({
    description: 'Attached show/movie card id (media_items id). Requires mediaType.',
  })
  @IsOptional()
  @IsString()
  mediaId?: string;

  @ApiPropertyOptional({
    description: 'Attached custom-list card id. Exclusive with other attachments.',
  })
  @IsOptional()
  @IsString()
  listId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  parentId?: string;

  @ApiPropertyOptional({ description: 'Author-marked spoiler — body is censored for readers.' })
  @IsOptional()
  @IsBoolean()
  isSpoiler?: boolean;

  @ApiPropertyOptional({ description: 'Reply target: an external (TMDB) review id.' })
  @IsOptional()
  @IsString()
  externalReviewId?: string;
}

export class UpdateCommentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  body?: string;

  @ApiPropertyOptional({ description: 'Set to null to clear an existing GIF attachment.' })
  @IsOptional()
  @IsString()
  @MaxLength(GIF_URL_MAX_LENGTH)
  gifUrl?: string | null;

  @ApiPropertyOptional({
    description: 'When true, detaches (deletes) the current image attachment.',
  })
  @IsOptional()
  @IsBoolean()
  detachImage?: boolean;
}

function normalizeSort(sort?: string): CommentSort {
  return sort === 'MOST_LIKED' ? 'MOST_LIKED' : 'LATEST';
}

export class CommentQueryDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiPropertyOptional({ enum: COMMENT_SORTS, default: 'LATEST' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number = 20;

  get resolvedSort(): CommentSort {
    return normalizeSort(this.sort);
  }
}

export class RepliesQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: COMMENT_SORTS, default: 'LATEST' })
  @IsOptional()
  @IsString()
  sort?: string;

  @ApiPropertyOptional({
    enum: [1, 2],
    default: 1,
    description:
      'Levels of descendants returned relative to the requested comment. 1 = direct children only ' +
      "(paginated). 2 = additionally each direct child's first children (capped per parent), flat " +
      'in the same items array; total always counts direct children only.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(2)
  depth?: number = 1;

  get resolvedSort(): CommentSort {
    return normalizeSort(this.sort);
  }
}

export class ReportCommentDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}

export class TranslateContentDto {
  @ApiProperty({
    enum: ['en', 'fr', 'es', 'pt-BR', 'de', 'it', 'ar', 'tr', 'hi', 'id', 'ja', 'ko', 'zh-CN'],
  })
  @IsString()
  @IsIn(['en', 'fr', 'es', 'pt-BR', 'de', 'it', 'ar', 'tr', 'hi', 'id', 'ja', 'ko', 'zh-CN'])
  targetLanguage!: string;
}
