import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Paginated } from '@tvwatch/shared';

export class PaginationDto {
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
  @Max(100)
  pageSize?: number = 20;
}

export function paginate<T>(items: T[], page = 1, pageSize = 20, total?: number): Paginated<T> {
  const t = total ?? items.length;
  return {
    items,
    page,
    pageSize,
    total: t,
    hasMore: page * pageSize < t,
  };
}
