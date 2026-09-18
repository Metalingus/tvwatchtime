import { Prisma } from '@prisma/client';
import { episodeAiredSql } from '../../common/utils/episode-progress.util';

/** Date-only releases use the viewer's local release day. */
export function watchNextAiredEpisodeSql(now: Date): Prisma.Sql {
  return episodeAiredSql(now);
}
