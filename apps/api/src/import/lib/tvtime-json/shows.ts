// TV Time shows.json normalization.
//
// shows.json rows: { uuid, id: { tvdb, imdb }, title, status, created_at,
//   seasons: [{ number, episodes: [{ id: { tvdb, imdb }, number, special,
//   is_watched, watched_at, rating }] }] }
//
// Only is_watched episodes become watched candidates (watchCount = 1 — the export
// carries a single watched_at per episode, no rewatch data). `special: true`
// episodes are embedded in REGULAR season numbers and share S/E keys with regular
// episodes, so the dedupe key includes the special flag and the footprint (used by
// the structural guard) counts non-special episodes only.
//
// The show-level `status` (up_to_date / continuing / …) is NOT imported.

import { normTitle, splitTitleYear } from '../inference';
import {
  asObj,
  boolOrFalse,
  dateOrNull,
  mediaKey,
  numOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeShowFootprint,
  type TvTimeShowsResult,
  type TvTimeWatchedEpisodeCandidate,
} from './types';

export function normalizeTvTimeJsonShows(data: unknown): TvTimeShowsResult {
  const episodes: TvTimeWatchedEpisodeCandidate[] = [];
  const footprints = new Map<string, TvTimeShowFootprint>();
  const seenEpisodes = new Set<string>();
  let invalid = 0;

  if (!Array.isArray(data)) return { episodes, footprints, invalid };

  for (const row of data) {
    const show = asObj(row);
    const rawTitle = strOrNull(show?.title);
    const showIds = parseTvTimeIds(show?.id);
    if (!show || !rawTitle) {
      invalid++;
      continue;
    }
    const { title, year } = splitTitleYear(rawTitle);
    const key = mediaKey(showIds, normTitle(title));
    let footprint = footprints.get(key);
    if (!footprint) {
      footprint = { key, showTitle: title, year, showIds, maxSeason: null, seasonEpisodes: [] };
      footprints.set(key, footprint);
    }
    const perSeason = new Map<number, number>();

    const seasons = Array.isArray(show.seasons) ? show.seasons : [];
    for (const rawSeason of seasons) {
      const s = asObj(rawSeason);
      const seasonNumber = numOrNull(s?.number);
      if (!s || seasonNumber == null) continue;
      const eps = Array.isArray(s.episodes) ? s.episodes : [];
      for (const rawEp of eps) {
        const e = asObj(rawEp);
        const number = numOrNull(e?.number);
        if (!e || number == null) {
          invalid++;
          continue;
        }
        const special = boolOrFalse(e.special);
        if (!special) {
          perSeason.set(seasonNumber, Math.max(perSeason.get(seasonNumber) ?? 0, number));
        }
        if (!boolOrFalse(e.is_watched)) continue;
        const dedupeKey = `${key}|s${seasonNumber}|e${number}|special:${special}`;
        if (seenEpisodes.has(dedupeKey)) continue;
        seenEpisodes.add(dedupeKey);
        episodes.push({
          showTitle: title,
          year,
          season: seasonNumber,
          episode: number,
          special,
          showIds,
          episodeIds: parseTvTimeIds(e.id),
          watchedAt: dateOrNull(e.watched_at),
        });
      }
    }

    footprint.maxSeason = perSeason.size ? Math.max(...perSeason.keys()) : null;
    footprint.seasonEpisodes = [...perSeason.entries()].map(([season, maxEpisode]) => ({ season, maxEpisode }));
  }

  return { episodes, footprints, invalid };
}
