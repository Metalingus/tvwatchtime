import { Prisma } from '@prisma/client';

/** Watch Next may only recommend an episode whose air date proves it has aired. */
export function watchNextAiredEpisodeSql(now: Date): Prisma.Sql {
  return Prisma.sql`e.air_date IS NOT NULL AND e.air_date <= ${now}`;
}
