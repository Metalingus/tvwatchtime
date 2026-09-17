import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { CommsUniWriteComment } from '@tvwatch/shared';

class BackfillRun {
  @IsUUID() runId!: string;
  @IsDateString() cutoff!: string;
}
export class CommsUniBackfillRequest extends BackfillRun {
  @IsOptional() @IsString() @MaxLength(2048) cursor?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
class BackfillEntry {
  @IsString() @MaxLength(128) commentId!: string;
  @Matches(/^[a-f0-9]{64}$/) proof!: string;
}
export class CommsUniBackfillApply extends BackfillRun {
  @IsBoolean() @Equals(true) acknowledgeHistoricalSharing!: boolean;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(25)
  @ValidateNested({ each: true })
  @Type(() => BackfillEntry)
  entries!: BackfillEntry[];
}
export interface CommsUniBackfillRow {
  commentId: string;
  userId: string;
  threadType: string;
  threadId: string;
  parentId: string | null;
  createdAt: string;
  status: 'eligible' | 'excluded' | 'blocked';
  reason: string;
  reference?: string;
  proof?: string;
  payload?: CommsUniWriteComment;
  author?: { displayName: string; avatarUrl: string | null };
}
export interface CommsUniBackfillPreview {
  version: 1;
  connectionScope: string;
  runId: string;
  cutoff: string;
  rows: CommsUniBackfillRow[];
  nextCursor: string | null;
  sourceCounts?: { source: string | null; count: number }[];
}
export interface CommsUniBackfillResult {
  commentId: string;
  status: 'queued' | 'existing' | 'blocked' | 'deferred';
  reason?: string;
  operationId?: string;
  state?: string;
}
