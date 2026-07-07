import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ListVisibility, MediaType } from '@prisma/client';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class CreateListDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  coverUrl?: string;

  @ApiPropertyOptional({ enum: ListVisibility })
  @IsOptional()
  @IsEnum(ListVisibility)
  visibility?: ListVisibility;
}

export class UpdateListDto extends CreateListDto {}

export class AddListItemDto {
  @ApiProperty({ enum: MediaType })
  @IsEnum(MediaType)
  mediaType!: MediaType;

  @ApiProperty()
  @IsString()
  mediaId!: string;
}
