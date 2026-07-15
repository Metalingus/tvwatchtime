import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';
import { ContactReason } from '@prisma/client';

export class CreateContactThreadDto {
  @ApiProperty({ enum: ContactReason })
  @IsEnum(ContactReason)
  reason!: ContactReason;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  subject!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class CreateContactMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body!: string;
}

export class ContactListQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}

export class AdminContactListQueryDto extends ContactListQueryDto {
  @IsOptional()
  @IsString()
  status?: string; // OPEN | CLOSED

  @IsOptional()
  @IsEnum(ContactReason)
  reason?: ContactReason;

  @IsOptional()
  @Type(() => Boolean)
  unread?: boolean;
}
