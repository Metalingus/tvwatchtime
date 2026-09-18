import { zonedDayRange } from './timezone.util';
import { Prisma } from '@prisma/client';
import { hasReleased } from '@tvwatch/shared';
import { currentCalendarDay, currentTimeZone } from '../timezone.context';

/** Preserve undated official episodes in progress; dated rows follow the release policy. */
export function isEpisodeProgressEligible(
  airDate: Date | null | undefined,
  now: Date = new Date(),
  airTime?: string | null,
): boolean {
  return !airDate || hasReleased(airDate, now, currentTimeZone(), !!airTime);
}

/** Positive bulk actions and Watch Next require a confirmed, elapsed release. */
export function isEpisodeBulkWatchEligible(
  airDate: Date | null | undefined,
  now: Date = new Date(),
  airTime?: string | null,
): boolean {
  return hasReleased(airDate, now, currentTimeZone(), !!airTime);
}

export function episodeAiredWhere(now = new Date()): Prisma.EpisodeWhereInput {
  return {
    OR: [
      {
        AND: [
          { OR: [{ airTime: null }, { airTime: '' }] },
          { airDate: { lt: new Date(currentCalendarDay(now).getTime() + 86400000) } },
        ],
      },
      { airTime: { not: null }, NOT: { airTime: '' }, airDate: { lte: now } },
    ],
  };
}

export function episodeProgressEligibilityWhere(now = new Date()): Prisma.EpisodeWhereInput {
  return { OR: [{ airDate: null }, episodeAiredWhere(now)] };
}

/** Alias is internal source code, never a request value. Keep dates parameterized. */
export function episodeAiredSql(now = new Date(), alias = 'e'): Prisma.Sql {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Invalid episode SQL alias');
  const date = Prisma.raw(alias + '.air_date');
  const time = Prisma.raw(alias + '.air_time');
  return Prisma.sql`(${date} IS NOT NULL AND (
    ((${time} IS NULL OR ${time} = '') AND ${date} < ${new Date(currentCalendarDay(now).getTime() + 86400000)})
    OR (${time} IS NOT NULL AND ${time} <> '' AND ${date} <= ${now})
  ))`;
}

export function episodeProgressSql(now = new Date(), alias = 'e'): Prisma.Sql {
  const aired = episodeAiredSql(now, alias);
  return Prisma.sql`(${Prisma.raw(alias + '.air_date')} IS NULL OR ${aired})`;
}

/** Calendar grouping is distinct from release eligibility (today can still be upcoming). */
export function episodeBeforeLocalDayWhere(now = new Date()): Prisma.EpisodeWhereInput {
  return {
    OR: [
      {
        AND: [
          { OR: [{ airTime: null }, { airTime: '' }] },
          { airDate: { lt: currentCalendarDay(now) } },
        ],
      },
      {
        airTime: { not: null },
        NOT: { airTime: '' },
        airDate: { lt: zonedDayRange(currentTimeZone(), now).start },
      },
    ],
  };
}
