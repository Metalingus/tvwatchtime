import { ApiPropertyOptional } from '@nestjs/swagger';
import { WatchDevice } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class MarkWatchedDto {
  @ApiPropertyOptional({ enum: WatchDevice })
  @IsOptional()
  @IsEnum(WatchDevice)
  device?: WatchDevice;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  reaction?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  favoriteCharacter?: string;
}
