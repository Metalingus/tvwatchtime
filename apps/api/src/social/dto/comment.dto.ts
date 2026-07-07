import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CommentThreadType } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateCommentDto {
  @ApiProperty({ enum: CommentThreadType })
  @IsEnum(CommentThreadType)
  threadType!: CommentThreadType;

  @ApiProperty()
  @IsString()
  threadId!: string;

  @ApiProperty()
  @IsString()
  body!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  imageUrl?: string;

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
