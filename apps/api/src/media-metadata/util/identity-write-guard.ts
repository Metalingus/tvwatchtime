import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { canonicalMediaId } from './canonical-media';

const PRIMARY_PROVIDERS = ['TMDB', 'THE_TVDB', 'IMDB'];

/**
 * True when attaching `(provider, kind, value)` would give the media a second, different
 * TMDB/TVDB/IMDb alias of the same kind. Unguarded attach paths (hydration upserts, routing
 * externals, backfills) must skip such a write: a changed provider crosswalk is evidence for
 * identity repair, never a silent second alias (the source of multi-alias rows).
 */
export async function wouldAddConflictingAlias(
  db: Pick<Prisma.TransactionClient, 'externalId'>,
  mediaId: string,
  provider: string,
  providerEntityKind: string,
  value: string,
): Promise<boolean> {
  if (!PRIMARY_PROVIDERS.includes(provider)) return false;
  const other = await db.externalId.findFirst({
    where: {
      mediaId,
      provider: provider as any,
      providerEntityKind: providerEntityKind as any,
      value: { not: value },
    },
    select: { id: true },
  });
  return !!other;
}

/** Cheap local guard. Provider discovery belongs outside the write transaction. */
export async function assertMediaIdentityWrite(
  db: Prisma.TransactionClient,
  mediaId: string,
  type: 'SHOW' | 'MOVIE',
  incoming: readonly { provider: string; value: string }[],
  primaryProvider?: string,
): Promise<void> {
  const row = await db.mediaItem.findUnique({
    where: { id: mediaId },
    select: {
      type: true,
      metadataProvenance: true,
      externalIds: true,
      show: { select: { id: true } },
      movie: { select: { id: true } },
      canonicalSource: { select: { status: true } },
    },
  });
  if (!row) throw new ConflictException('Media identity disappeared');
  if (
    row.type !== type ||
    (type === 'MOVIE' ? row.show : row.movie) ||
    row.canonicalSource?.status === 'ACTIVE'
  ) {
    throw new ConflictException('Media identity needs reconciliation before hydration');
  }
  const kind = type === 'SHOW' ? 'SERIES' : 'MOVIE';
  if (
    row.externalIds.some(
      (id) => ['TMDB', 'THE_TVDB', 'IMDB'].includes(id.provider) && id.providerEntityKind !== kind,
    )
  ) {
    throw new ConflictException('Wrong-kind aliases require an identity split');
  }
  for (const provider of ['TMDB', 'THE_TVDB', 'IMDB']) {
    const stored = (row.externalIds ?? [])
      .filter((id) => id.provider === provider && id.providerEntityKind === kind)
      .map((id) => id.value);
    const supplied = [
      ...new Set(incoming.filter((id) => id.provider === provider).map((id) => id.value)),
    ];
    const audit = (row.metadataProvenance as any)?.tvdbIdAudit;
    const benign =
      provider === 'THE_TVDB' &&
      audit?.status === 'benign' &&
      audit.fingerprint ===
        createHash('md5')
          .update([...stored].sort().join('|'))
          .digest('hex');
    if (
      (!benign && (stored.length > 1 || supplied.length > 1)) ||
      (stored.length && supplied.length && !supplied.some((id) => stored.includes(id)))
    ) {
      throw new ConflictException('Conflicting provider identities require an identity repair');
    }
    if (provider === primaryProvider) {
      for (const value of supplied) {
        const owner = await db.externalId.findFirst({
          where: { provider: provider as any, providerEntityKind: kind, value },
          select: { mediaId: true },
        });
        if (owner && (await canonicalMediaId(db as any, owner.mediaId)) !== mediaId) {
          throw new ConflictException('Provider identity is owned by another media record');
        }
      }
    }
  }
}
