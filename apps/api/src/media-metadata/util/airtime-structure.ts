export type AirtimeEpisodeCoordinate = {
  number: number;
  season: { number: number };
};

/**
 * TVmaze airtimes are keyed only by season/episode coordinates. Those coordinates are safe to
 * apply only when TVmaze and the canonical provider expose the exact same episode set for that
 * season. A count-only comparison is insufficient because split/combined broadcasts can retain
 * the same total while numbering different episodes.
 */
export function compatibleAirtimeSeasons(
  airtimeKeys: Iterable<string>,
  canonicalEpisodes: AirtimeEpisodeCoordinate[],
): Set<number> {
  const canonical = new Map<number, { count: number; numbers: Set<number> }>();
  for (const episode of canonicalEpisodes) {
    const seasonNumber = episode.season.number;
    const entry = canonical.get(seasonNumber) ?? { count: 0, numbers: new Set<number>() };
    entry.count++;
    entry.numbers.add(episode.number);
    canonical.set(seasonNumber, entry);
  }

  const remote = new Map<number, Set<number>>();
  for (const key of airtimeKeys) {
    const match = /^(\d+)-(\d+)$/.exec(key);
    if (!match) continue;
    const seasonNumber = Number(match[1]);
    const episodeNumber = Number(match[2]);
    if (!Number.isSafeInteger(seasonNumber) || !Number.isSafeInteger(episodeNumber)) continue;
    const numbers = remote.get(seasonNumber) ?? new Set<number>();
    numbers.add(episodeNumber);
    remote.set(seasonNumber, numbers);
  }

  const compatible = new Set<number>();
  for (const [seasonNumber, local] of canonical) {
    const provider = remote.get(seasonNumber);
    if (!provider || local.count !== local.numbers.size || provider.size !== local.numbers.size) {
      continue;
    }
    if ([...local.numbers].every((episodeNumber) => provider.has(episodeNumber))) {
      compatible.add(seasonNumber);
    }
  }
  return compatible;
}
