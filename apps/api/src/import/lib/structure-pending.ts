/**
 * Durable marker for import rows whose show graph must be reconciled before an episode
 * target can be trusted. Keep this distinct from cast-related PENDING_MATCH rows.
 */
export const STRUCTURE_PENDING_ERROR = 'Awaiting background TV structure migration';
export const IDENTITY_PENDING_ERROR = 'Awaiting background media identity repair';
export const IDENTITY_REVIEW_ERROR = 'Media identity could not be verified';
export const IMPORT_CANCELLED_PENDING_ERROR =
  'Import cancelled before background matching finished';

import type { PrismaService } from '../../common/prisma/prisma.service';
import type { HydrationQueue } from '../../media-metadata/hydration/hydration.queue';
import { isCompletedTvTimeImport } from './completed-import-policy';

/** The import is fully staged before its catalog repair runs, closing the fast-worker race. */
export async function enqueuePendingIdentityRepairs(
  prisma: PrismaService,
  queue: HydrationQueue | undefined,
  importId: string,
) {
  if (typeof queue?.enqueueIdentityRepair !== 'function') return;
  const current = await prisma.import.findUnique({
    where: { id: importId },
    select: { status: true, format: true },
  });
  if (
    !current ||
    isCompletedTvTimeImport(current) ||
    !['READY_FOR_REVIEW', 'COMPLETED'].includes(current.status)
  )
    return;
  const rows = await prisma.importItem.findMany({
    where: {
      importId,
      status: 'PENDING_MATCH',
      errorMessage: IDENTITY_PENDING_ERROR,
      matchedMediaId: { not: null },
    },
    select: { matchedMediaId: true },
    distinct: ['matchedMediaId'],
    take: 100,
  });
  await Promise.all(rows.map((row) => queue.enqueueIdentityRepair(row.matchedMediaId!, importId)));
}

/** Legacy marker: rows produced by older builds are replayed and healed automatically. */
export const STRUCTURE_REVIEW_ERROR = 'TV structure migration needs manual review';

/** Auditable terminal marker for a provider episode row that has no proven canonical target. */
export const STRUCTURE_SKIPPED_ERROR = 'Skipped unprovable provider episode artifact';
