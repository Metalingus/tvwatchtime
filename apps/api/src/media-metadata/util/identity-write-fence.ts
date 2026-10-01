import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type IdentityWriteScope = {
  mediaIds?: string[];
  episodeIds?: string[];
  type?: 'SHOW' | 'MOVIE';
  userId?: string;
  mediaTypes?: Record<string, 'SHOW' | 'MOVIE'>;
};

/**
 * Call inside the existing mutation transaction, before reading mutable user state.
 * KEY SHARE permits concurrent user writes but conflicts with a repair's FOR UPDATE.
 * Recheck after the lock: identifiers resolved before the transaction can be stale.
 */
export async function fenceIdentityWrite(tx: Prisma.TransactionClient, scope: IdentityWriteScope) {
  const episodeIds = [...new Set(scope.episodeIds ?? [])];
  const readEpisodes = () =>
    chunkRead(episodeIds, (ids) =>
      tx.episode.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          structureState: true,
          season: { select: { show: { select: { mediaId: true } } } },
        },
      }),
    );
  const episodes = episodeIds.length ? await readEpisodes() : [];
  const ids = [
    ...new Set([...(scope.mediaIds ?? []), ...episodes.map((e) => e.season.show.mediaId)]),
  ].sort();
  if (episodeIds.length !== episodes.length || episodes.some((e) => e.structureState !== 'ACTIVE'))
    throw changed();
  if (!ids.length) return;
  for (let i = 0; i < ids.length; i += 5000)
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM media_items WHERE id IN (${Prisma.join(ids.slice(i, i + 5000))}) ORDER BY id FOR KEY SHARE`,
    );
  if (scope.userId)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'tvwatch:user-write:' + scope.userId},0))`;
  const retired = await chunkRead(ids, (page) =>
    tx.mediaCanonicalLink.findMany({
      where: { sourceMediaId: { in: page }, status: 'ACTIVE' },
      select: { sourceMediaId: true },
    }),
  );
  if (retired.length) throw changed();
  const rows = await chunkRead(ids, (page) =>
    tx.mediaItem.findMany({
      where: { id: { in: page } },
      select: {
        id: true,
        type: true,
        show: { select: { id: true } },
        movie: { select: { id: true } },
      },
    }),
  );
  if (
    rows.length !== ids.length ||
    rows.some(
      (row) =>
        (scope.type && row.type !== scope.type) ||
        (scope.mediaTypes?.[row.id] && scope.mediaTypes[row.id] !== row.type) ||
        // A row still carrying the other type's graph (a movie with a stray show) accepts
        // writes of its own type: a split moves only the stray graph's data, and a running
        // repair holds FOR UPDATE on the row, so these writes cannot interleave with it.
        // Episode writes into a movie row's stray show graph stay refused.
        (episodes.length > 0 && row.type === 'MOVIE' && !!row.show),
    )
  )
    throw changed();
  if (episodeIds.length) {
    const after = await readEpisodes();
    if (
      after.length !== episodeIds.length ||
      after.some((e) => e.structureState !== 'ACTIVE' || !ids.includes(e.season.show.mediaId))
    )
      throw changed();
  }
}

/** Full hydration/season writers share the same exclusive row lock as canonical cutover. */
export async function fenceMetadataWrite(
  tx: Prisma.TransactionClient,
  mediaId: string,
  type: 'SHOW' | 'MOVIE',
) {
  await tx.$queryRaw`SELECT id FROM media_items WHERE id=${mediaId} FOR UPDATE`;
  const media = await tx.mediaItem.findUnique({
    where: { id: mediaId },
    select: { type: true, canonicalSource: { select: { status: true } } },
  });
  if (!media || media.type !== type || media.canonicalSource?.status === 'ACTIVE') throw changed();
}

/** Existing structure-remap transactions take the exclusive side before transferring rows. */
export async function fenceEpisodeRepair(tx: Prisma.TransactionClient, episodeIds: string[]) {
  const ids = [...new Set(episodeIds)];
  if (!ids.length) return;
  await tx.$queryRaw(Prisma.sql`SELECT m.id FROM media_items m WHERE m.id IN (
    SELECT sh.media_id FROM shows sh JOIN seasons s ON s.show_id=sh.id JOIN episodes e ON e.season_id=s.id
    WHERE e.id IN (${Prisma.join(ids)})
  ) ORDER BY m.id FOR UPDATE`);
  if ((await tx.episode.count({ where: { id: { in: ids } } })) !== ids.length) throw changed();
  // A pre-cutover repeatable-read snapshot must fail after waiting on this lock.
  await tx.$executeRaw(Prisma.sql`UPDATE media_items SET updated_at=clock_timestamp() WHERE id IN (
    SELECT sh.media_id FROM shows sh JOIN seasons s ON s.show_id=sh.id JOIN episodes e ON e.season_id=s.id
    WHERE e.id IN (${Prisma.join(ids)})
  )`);
}

async function chunkRead<T>(ids: string[], read: (page: string[]) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  for (let i = 0; i < ids.length; i += 5000) result.push(...(await read(ids.slice(i, i + 5000))));
  return result;
}

function changed() {
  return new ConflictException({
    code: 'IDENTITY_CHANGED',
    message: 'This media identity changed or needs repair. Refresh before changing it.',
  });
}
