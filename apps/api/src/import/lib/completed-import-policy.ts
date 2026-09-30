import type { Prisma } from '@prisma/client';

/** Completed TV Time archives are never reopened or replayed by metadata recovery. */
export function isCompletedTvTimeImport(
  value: { status?: string; format?: string | null } | null | undefined,
): boolean {
  return (
    value?.status === 'COMPLETED' && (!value.format || value.format.toLowerCase() === 'tvtime')
  );
}

export const EXCLUDE_COMPLETED_TVTIME = {
  NOT: { status: 'COMPLETED', format: { in: ['tvtime', ''] } },
} satisfies Prisma.ImportWhereInput;
