import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Latest watch per title for the "Date watched" library order: a show's latest watched
 * episode (`user_show_status.last_watched_at`), a movie's latest watch including rewatches
 * (`watch_history`; `user_movie_status.watched_at` only records the first watch).
 */
export async function latestWatchByMedia(
  prisma: PrismaService,
  userId: string,
  mediaIds: string[],
): Promise<Map<string, number>> {
  const latest = new Map<string, number>();
  if (!mediaIds.length) return latest;
  const keep = (mediaId: string, at: Date | null | undefined) => {
    const time = at ? at.getTime() : NaN;
    if (Number.isFinite(time) && time > (latest.get(mediaId) ?? -Infinity))
      latest.set(mediaId, time);
  };
  const [shows, movies, history] = await Promise.all([
    prisma.userShowStatus.findMany({
      where: { userId, mediaId: { in: mediaIds } },
      select: { mediaId: true, lastWatchedAt: true },
    }),
    prisma.userMovieStatus.findMany({
      where: { userId, mediaId: { in: mediaIds }, watched: true },
      select: { mediaId: true, watchedAt: true },
    }),
    prisma.$queryRaw<Array<{ mediaId: string; at: Date | null }>>`
      SELECT media_id AS "mediaId", MAX(watched_at) AS at
      FROM watch_history
      WHERE user_id = ${userId}
        AND media_type = 'MOVIE'::"MediaType"
        AND media_id IN (${Prisma.join(mediaIds)})
      GROUP BY media_id
    `,
  ]);
  for (const row of shows) keep(row.mediaId, row.lastWatchedAt);
  for (const row of movies) keep(row.mediaId, row.watchedAt);
  for (const row of history) keep(row.mediaId, row.at);
  return latest;
}

/** Latest watch first; never-watched titles after, by date added (newest first). */
export function sortByLatestWatch<T extends { id: string; mediaId: string; addedAt: Date }>(
  rows: T[],
  latest: Map<string, number>,
): T[] {
  return [...rows].sort((a, b) => {
    const wa = latest.get(a.mediaId);
    const wb = latest.get(b.mediaId);
    if (wa !== undefined || wb !== undefined) {
      if (wa === undefined) return 1;
      if (wb === undefined) return -1;
      if (wa !== wb) return wb - wa;
    }
    const added = b.addedAt.getTime() - a.addedAt.getTime();
    return added || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
  });
}
