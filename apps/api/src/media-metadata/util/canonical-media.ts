import { ConflictException } from '@nestjs/common';
import { canonicalEpisodeTargets } from './episode-identity';
import type { Prisma, PrismaClient } from '@prisma/client';

type Reader = Pick<PrismaClient | Prisma.TransactionClient, 'mediaCanonicalLink' | 'mediaItem'>;

export async function canonicalCopyId(
  db: Pick<PrismaClient | Prisma.TransactionClient, 'mediaCanonicalCopy'>,
  entityType: 'EPISODE' | 'CAST' | 'COMMENT' | 'LIST_ITEM',
  sourceId: string,
): Promise<string> {
  if (entityType === 'EPISODE' && typeof db.mediaCanonicalCopy?.findMany === 'function') {
    const targets = await canonicalEpisodeTargets(db, sourceId);
    if (targets.length !== 1)
      throw new ConflictException({
        code: 'IDENTITY_CHANGED',
        message: 'This episode was split. Refresh the show and select the current episodes.',
      });
    return targets[0];
  }
  let current = sourceId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) throw new Error('Cyclic canonical copy');
    seen.add(current);
    const copy = await db.mediaCanonicalCopy?.findFirst?.({
      where: { entityType, sourceId: current, link: { status: 'ACTIVE' } },
      select: { targetId: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!copy) return current;
    current = copy.targetId;
  }
  throw new Error('Canonical copy depth exceeded');
}

/** One redirect reader shared by lookup, hydration, imports, and repair boundaries. */
export async function canonicalMediaId(
  db: Reader,
  mediaId: string,
  expectedType?: 'SHOW' | 'MOVIE',
): Promise<string> {
  let current = mediaId;
  const seen = new Set<string>();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(current)) throw new Error('Cyclic canonical media identity');
    seen.add(current);
    const link = await db.mediaCanonicalLink?.findUnique?.({
      where: { sourceMediaId: current },
      select: { status: true, targetMediaId: true },
    });
    if (link?.status === 'ACTIVE') {
      current = link.targetMediaId;
      continue;
    }
    if (expectedType) {
      const media = await db.mediaItem?.findUnique?.({
        where: { id: current },
        select: { type: true, metadataProvenance: true },
      });
      const split = (media?.metadataProvenance as Record<string, any> | null)?.identitySplit;
      const target = split?.targets?.[expectedType];
      if (
        media &&
        media.type !== expectedType &&
        typeof target === 'string' &&
        target !== current
      ) {
        current = target;
        continue;
      }
    }
    return current;
  }
  throw new Error('Canonical media redirect depth exceeded');
}
