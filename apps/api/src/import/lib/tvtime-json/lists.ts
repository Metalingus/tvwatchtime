// TV Time lists.json normalization.
//
// lists.json rows: { name, description, is_public, shows: [{ id, title, uuid,
//   seasons, added_at }], movies: [...] }
//
// The export carries no list id, so the sourceKey is derived from the normalized
// name — stable across re-imports of the same export. Visibility respects
// is_public (confirmed with the product owner; the legacy CSV path defaults
// PRIVATE because it has no visibility signal). Embedded seasons are ignored for
// membership (their episode ratings are harvested by ratings.ts).

import { normTitle, splitTitleYear } from '../inference';
import {
  asObj,
  dateOrNull,
  parseTvTimeIds,
  strOrNull,
  type TvTimeListCandidate,
  type TvTimeListItemCandidate,
  type TvTimeListsResult,
} from './types';

export function normalizeTvTimeJsonLists(data: unknown): TvTimeListsResult {
  const lists: TvTimeListCandidate[] = [];
  let skippedLists = 0;

  if (!Array.isArray(data)) return { lists, skippedLists };

  data.forEach((raw, index) => {
    const l = asObj(raw);
    const title = strOrNull(l?.name);
    if (!l || !title) {
      skippedLists++;
      return;
    }
    const items: TvTimeListItemCandidate[] = [];
    let skippedItems = 0;

    const collect = (rows: unknown, mediaType: 'show' | 'movie') => {
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        const r = asObj(row);
        const rawTitle = strOrNull(r?.title);
        if (!r || !rawTitle) {
          skippedItems++;
          continue;
        }
        const { title: clean, year } = splitTitleYear(rawTitle);
        items.push({
          mediaType,
          title: clean,
          year,
          ids: parseTvTimeIds(r.id),
          order: items.length + 1,
          createdAt: dateOrNull(r.added_at),
        });
      }
    };

    collect(l.shows, 'show');
    collect(l.movies, 'movie');

    lists.push({
      sourceKey: `tvtime:list:${normTitle(title) || index}`,
      title: title.trim(),
      description: strOrNull(l.description),
      visibility: l.is_public === true ? 'PUBLIC' : 'PRIVATE',
      createdAt: null,
      items,
      skippedItems,
    });
  });

  return { lists, skippedLists };
}
