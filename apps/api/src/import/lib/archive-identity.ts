import { normalizeNumericExternalId, normTitle, splitTitleYear } from './inference';

export type ArchiveShowIdentity = {
  title: string;
  normTitle: string;
  rawNormTitle: string;
  year: number | null;
  key: string;
};

export type ArchiveEpisodeMatch = {
  mediaId: string;
  episodeId: string;
};

export type ArchiveEpisodeCoordinate = {
  showTitle: string | null;
  seriesId: string | null;
  season: number;
  episode: number;
};

export type ArchiveMovieIdentity = {
  title: string;
  normTitle: string;
  titleCandidates: { title: string; normTitle: string }[];
  hasCanonicalRangeTitle: boolean;
  year: number | null;
  uuid: string | null;
  key: string;
};

const SHOW_TITLE_FIELDS = new Set(['tv_show_name', 'series_name', 'show_name']);
const TVDB_SERIES_ID_FIELDS = new Set(['tv_show_id', 'series_id', 's_id']);
const TVDB_EPISODE_ID_FIELDS = ['episode_id', 'ep_id'];
const SEASON_NUMBER_FIELDS = ['episode_season_number', 'season_number', 's_no'];
const EPISODE_NUMBER_FIELDS = ['episode_number', 'ep_no'];
const ARCHIVE_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeArchiveUuid(value: unknown): string | null {
  const uuid = String(value ?? '')
    .trim()
    .toLowerCase();
  return ARCHIVE_UUID_RE.test(uuid) ? uuid : null;
}

function yearFromRawRow(row: Record<string, string>): number | null {
  for (const rawKey of ['year', 'release_year', 'release_date']) {
    const value = String(row[rawKey] ?? '').trim();
    if (!value || value === '<nil>' || value.startsWith('0001')) continue;
    const match = value.match(/(?:^|\D)((?:19|20)\d{2})(?:\D|$)/);
    if (match) return Number(match[1]);
  }
  return null;
}

function positiveIntegerFromRawRow(row: Record<string, string>, fields: string[]): number | null {
  for (const field of fields) {
    const normalized = normalizeNumericExternalId(row[field]);
    if (normalized && /^\d+$/.test(normalized)) {
      const value = Number(normalized);
      if (Number.isSafeInteger(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * TV Time's tracking rows carry a stable, English-ish title slug after a routing prefix
 * (for example `watch-alpha-mortal` or
 * `rewatch_count-alpha-watch-alpha-wish-dragon`). This is archive identity evidence, not a
 * provider id, so callers must pair it with the row's movie UUID and release year.
 */
export function canonicalMovieTitleFromRangeKey(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const nestedPrefix = 'rewatch_count-alpha-watch-alpha-';
  const lower = raw.toLowerCase();
  let slug: string | null = null;
  if (lower.startsWith(nestedPrefix)) {
    slug = raw.slice(nestedPrefix.length);
  } else {
    const match = /^(?:follow|watch|towatch)-alpha-(.+)$/i.exec(raw);
    slug = match?.[1] ?? null;
  }
  if (!slug?.trim()) return null;
  const title = slug.replace(/-+/g, ' ').replace(/\s+/g, ' ').trim();
  return normTitle(title) ? title : null;
}

/**
 * TV Time repeats the release year inside titles in some files ("The Flash (2014)") while
 * the main history normalizer stores the same show as title="The Flash", year=2014. Keep one
 * canonical, year-aware identity so every file in the archive can share an authoritative match.
 */
export function archiveShowIdentity(
  rawTitle: string,
  explicitYear?: number | null,
): ArchiveShowIdentity {
  const raw = rawTitle.trim();
  const split = splitTitleYear(raw);
  const year = explicitYear ?? split.year;
  const normalized = normTitle(split.title);
  return {
    title: split.title,
    normTitle: normalized,
    rawNormTitle: normTitle(raw),
    year,
    key: JSON.stringify([normalized, year]),
  };
}

/**
 * Partition rows before deduplication/matching. A normalized title and nullable year are not a
 * unique identity: secondary TV Time files can omit the year even when the archive contains two
 * same-title remakes. Prefer the exact local episode owner, then the row's TVDB series id, and
 * use title/year only when the row carries no stronger identity.
 */
export function archiveShowPartitionKey(
  rawTitle: string,
  explicitYear?: number | null,
  rawTvdbSeriesId?: string | number | null,
  episodeOwnerMediaId?: string | null,
): string {
  const mediaId = episodeOwnerMediaId?.trim();
  if (mediaId) return `media:${mediaId}`;
  const seriesId = normalizeNumericExternalId(rawTvdbSeriesId);
  if (seriesId && /^\d+$/.test(seriesId)) return `tvdb:${seriesId}`;
  return `title:${archiveShowIdentity(rawTitle, explicitYear).key}`;
}

/**
 * Per-import evidence graph. It never guesses across conflicting identities: a title/year or
 * TVDB episode id that resolves to two local objects becomes ambiguous and falls back to the
 * normal review-safe matcher.
 */
export class ArchiveIdentityIndex {
  private readonly seriesIdsByKey = new Map<string, Set<string>>();
  private readonly seriesIdsByNorm = new Map<string, Set<string>>();
  private readonly mediaByKey = new Map<string, string | null>();
  private readonly mediaIdsByNorm = new Map<string, Set<string>>();
  private readonly episodeByTvdbId = new Map<string, ArchiveEpisodeMatch | null>();
  private readonly episodeCoordinateByTvdbId = new Map<string, ArchiveEpisodeCoordinate | null>();
  private readonly episodeRecoveryByKey = new Map<string, Promise<string | null>>();
  private readonly episodeIdsByShowSeason = new Map<
    string,
    { showTitle: string; seriesId: string | null; season: number; episodeIds: Set<string> }
  >();
  private readonly movieEvidenceByUuid = new Map<
    string,
    { titles: Map<string, string>; canonicalTitles: Map<string, string>; years: Set<number> }
  >();
  private readonly movieUuidsByNorm = new Map<string, Set<string>>();
  private readonly movieMediaByUuid = new Map<string, string | null>();
  private readonly movieMediaByKey = new Map<string, string | null>();
  private readonly movieMediaIdsByNorm = new Map<string, Set<string>>();

  identifyShow(rawTitle: string, explicitYear?: number | null): ArchiveShowIdentity {
    return archiveShowIdentity(rawTitle, explicitYear);
  }

  addShowEvidence(
    rawTitle: string,
    explicitYear?: number | null,
    rawTvdbSeriesId?: string | number | null,
  ): void {
    const identity = this.identifyShow(rawTitle, explicitYear);
    const id = normalizeNumericExternalId(rawTvdbSeriesId);
    if (!identity.normTitle || !id || !/^\d+$/.test(id)) return;

    const exact = this.seriesIdsByKey.get(identity.key) ?? new Set<string>();
    exact.add(id);
    this.seriesIdsByKey.set(identity.key, exact);

    const byNorm = this.seriesIdsByNorm.get(identity.normTitle) ?? new Set<string>();
    byNorm.add(id);
    this.seriesIdsByNorm.set(identity.normTitle, byNorm);
  }

  addMovieEvidence(rawTitle: string, rawUuid?: string | null, explicitYear?: number | null): void {
    const uuid = normalizeArchiveUuid(rawUuid);
    const title = rawTitle.trim();
    const normalized = normTitle(title);
    if (!uuid || !normalized) return;

    const evidence = this.movieEvidenceByUuid.get(uuid) ?? {
      titles: new Map<string, string>(),
      canonicalTitles: new Map<string, string>(),
      years: new Set<number>(),
    };
    evidence.titles.set(normalized, title);
    if (explicitYear != null && explicitYear >= 1870 && explicitYear <= 2100) {
      evidence.years.add(explicitYear);
    }
    this.movieEvidenceByUuid.set(uuid, evidence);

    const uuids = this.movieUuidsByNorm.get(normalized) ?? new Set<string>();
    uuids.add(uuid);
    this.movieUuidsByNorm.set(normalized, uuids);
  }

  /** Collect conservative TVDB series evidence directly from any parsed GDPR CSV row. */
  addRawRowEvidence(row: Record<string, string>): void {
    let title: string | null = null;
    let seriesId: string | null = null;
    for (const [rawKey, rawValue] of Object.entries(row)) {
      const key = rawKey.toLowerCase().trim();
      if (!SHOW_TITLE_FIELDS.has(key) && !TVDB_SERIES_ID_FIELDS.has(key)) continue;
      const value = String(rawValue ?? '').trim();
      if (!value || value === '<nil>') continue;
      if (!title && SHOW_TITLE_FIELDS.has(key)) title = value;
      if (!seriesId && TVDB_SERIES_ID_FIELDS.has(key)) seriesId = value;
      if (title && seriesId) break;
    }
    if (title && seriesId) this.addShowEvidence(title, undefined, seriesId);

    const lowered = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase().trim(), value]),
    );
    const tvdbEpisodeId = TVDB_EPISODE_ID_FIELDS.map((field) =>
      normalizeNumericExternalId(lowered[field]),
    ).find((value): value is string => !!value && /^\d+$/.test(value));
    const season = positiveIntegerFromRawRow(lowered, SEASON_NUMBER_FIELDS);
    const episode = positiveIntegerFromRawRow(lowered, EPISODE_NUMBER_FIELDS);
    if (tvdbEpisodeId && title && season != null) {
      const normalizedSeriesId = normalizeNumericExternalId(seriesId);
      const groupKey = JSON.stringify([normalizedSeriesId ?? normTitle(title), season]);
      const group = this.episodeIdsByShowSeason.get(groupKey) ?? {
        showTitle: title,
        seriesId: normalizedSeriesId,
        season,
        episodeIds: new Set<string>(),
      };
      group.episodeIds.add(tvdbEpisodeId);
      this.episodeIdsByShowSeason.set(groupKey, group);
    }
    if (tvdbEpisodeId && season != null && episode != null) {
      const coordinate: ArchiveEpisodeCoordinate = {
        showTitle: title,
        seriesId: normalizeNumericExternalId(seriesId),
        season,
        episode,
      };
      const existing = this.episodeCoordinateByTvdbId.get(tvdbEpisodeId);
      if (existing === undefined) {
        this.episodeCoordinateByTvdbId.set(tvdbEpisodeId, coordinate);
      } else if (
        existing == null ||
        existing.season !== season ||
        existing.episode !== episode ||
        (existing.seriesId && coordinate.seriesId && existing.seriesId !== coordinate.seriesId)
      ) {
        this.episodeCoordinateByTvdbId.set(tvdbEpisodeId, null);
      } else {
        this.episodeCoordinateByTvdbId.set(tvdbEpisodeId, {
          showTitle: existing.showTitle ?? coordinate.showTitle,
          seriesId: existing.seriesId ?? coordinate.seriesId,
          season,
          episode,
        });
      }
    }
    const movieTitle = String(lowered['movie_name'] ?? lowered['movie_title'] ?? '').trim();
    if (movieTitle && movieTitle !== '<nil>') {
      const entityType = String(lowered['entity_type'] ?? '')
        .trim()
        .toLowerCase();
      const entityUuid =
        entityType === 'movie' ? normalizeArchiveUuid(lowered['entity_uuid']) : null;
      const movieUuid = entityUuid ?? normalizeArchiveUuid(lowered['uuid']);
      if (movieUuid) {
        const year = yearFromRawRow(lowered);
        this.addMovieEvidence(movieTitle, movieUuid, year);
        // `alpha_range_key` is trusted only on a UUID-bearing movie row with a real release
        // year. That prevents generic routing keys from becoming title aliases.
        const canonicalTitle = canonicalMovieTitleFromRangeKey(lowered['alpha_range_key']);
        if (canonicalTitle && year != null) {
          const evidence = this.movieEvidenceByUuid.get(movieUuid)!;
          const canonicalNorm = normTitle(canonicalTitle);
          evidence.canonicalTitles.set(canonicalNorm, canonicalTitle);
          const uuids = this.movieUuidsByNorm.get(canonicalNorm) ?? new Set<string>();
          uuids.add(movieUuid);
          this.movieUuidsByNorm.set(canonicalNorm, uuids);
        }
      }
    }
  }

  identifyMovie(
    rawTitle: string,
    explicitYear?: number | null,
    rawUuid?: string | null,
  ): ArchiveMovieIdentity {
    const inputTitle = rawTitle.trim();
    const inputNorm = normTitle(inputTitle);
    let uuid = normalizeArchiveUuid(rawUuid);
    if (!uuid) {
      const candidates = this.movieUuidsByNorm.get(inputNorm);
      if (candidates?.size === 1) uuid = [...candidates][0];
    }

    const evidence = uuid ? this.movieEvidenceByUuid.get(uuid) : null;
    const evidenceTitles = evidence ? [...evidence.titles.entries()] : [];
    const canonicalRangeTitles = evidence ? [...evidence.canonicalTitles.entries()] : [];
    const preferred =
      canonicalRangeTitles[0] ?? (evidenceTitles.length === 1 ? evidenceTitles[0] : null);
    const canonicalTitle = preferred?.[1] ?? inputTitle;
    const canonicalNorm = preferred?.[0] ?? inputNorm;
    const titleCandidates = [
      ...new Map(
        [...canonicalRangeTitles, ...evidenceTitles, [inputNorm, inputTitle] as [string, string]]
          .filter(([normalized]) => Boolean(normalized))
          .map(([normalized, candidateTitle]) => [
            normalized,
            { title: candidateTitle, normTitle: normalized },
          ]),
      ).values(),
    ];
    const years = new Set<number>(evidence?.years ?? []);
    if (explicitYear != null) years.add(explicitYear);
    const sortedYears = [...years].sort((a, b) => a - b);
    const year =
      sortedYears.length === 0
        ? null
        : sortedYears[sortedYears.length - 1] - sortedYears[0] <= 1
          ? sortedYears[0]
          : null;
    return {
      title: canonicalTitle,
      normTitle: canonicalNorm,
      titleCandidates,
      hasCanonicalRangeTitle: canonicalRangeTitles.length > 0,
      year,
      uuid,
      key: uuid ? `uuid:${uuid}` : `title:${JSON.stringify([canonicalNorm, year])}`,
    };
  }

  bindMovie(
    rawTitle: string,
    explicitYear: number | null | undefined,
    rawUuid: string | null | undefined,
    mediaId: string,
  ): void {
    const identity = this.identifyMovie(rawTitle, explicitYear, rawUuid);
    if (!identity.normTitle) return;

    const bind = (map: Map<string, string | null>, key: string) => {
      if (!map.has(key)) map.set(key, mediaId);
      else if (map.get(key) !== mediaId) map.set(key, null);
    };
    bind(this.movieMediaByKey, identity.key);
    if (identity.uuid) bind(this.movieMediaByUuid, identity.uuid);

    const byNorm = this.movieMediaIdsByNorm.get(identity.normTitle) ?? new Set<string>();
    byNorm.add(mediaId);
    this.movieMediaIdsByNorm.set(identity.normTitle, byNorm);
  }

  resolveMovie(
    rawTitle: string,
    explicitYear?: number | null,
    rawUuid?: string | null,
  ): string | null {
    const identity = this.identifyMovie(rawTitle, explicitYear, rawUuid);
    if (identity.uuid && this.movieMediaByUuid.has(identity.uuid)) {
      return this.movieMediaByUuid.get(identity.uuid) ?? null;
    }
    if (this.movieMediaByKey.has(identity.key))
      return this.movieMediaByKey.get(identity.key) ?? null;
    const byNorm = this.movieMediaIdsByNorm.get(identity.normTitle);
    return byNorm?.size === 1 ? [...byNorm][0] : null;
  }

  seriesIdsFor(rawTitle: string, explicitYear?: number | null): string[] {
    const identity = this.identifyShow(rawTitle, explicitYear);
    const exact = this.seriesIdsByKey.get(identity.key);
    if (exact?.size) return [...exact];
    const byNorm = this.seriesIdsByNorm.get(identity.normTitle);
    return byNorm?.size === 1 ? [...byNorm] : [];
  }

  allSeriesIds(): string[] {
    return [...new Set([...this.seriesIdsByNorm.values()].flatMap((ids) => [...ids]))];
  }

  bindShow(rawTitle: string, explicitYear: number | null | undefined, mediaId: string): void {
    const identity = this.identifyShow(rawTitle, explicitYear);
    if (!identity.normTitle) return;

    if (!this.mediaByKey.has(identity.key)) {
      this.mediaByKey.set(identity.key, mediaId);
    } else if (this.mediaByKey.get(identity.key) !== mediaId) {
      this.mediaByKey.set(identity.key, null);
    }

    const byNorm = this.mediaIdsByNorm.get(identity.normTitle) ?? new Set<string>();
    byNorm.add(mediaId);
    this.mediaIdsByNorm.set(identity.normTitle, byNorm);
  }

  resolveShow(rawTitle: string, explicitYear?: number | null): string | null {
    const identity = this.identifyShow(rawTitle, explicitYear);
    if (this.mediaByKey.has(identity.key)) return this.mediaByKey.get(identity.key) ?? null;
    const byNorm = this.mediaIdsByNorm.get(identity.normTitle);
    return byNorm?.size === 1 ? [...byNorm][0] : null;
  }

  bindEpisode(
    rawTvdbEpisodeId: string | number | null | undefined,
    mediaId: string,
    episodeId: string,
  ): void {
    const tvdbEpisodeId = normalizeNumericExternalId(rawTvdbEpisodeId);
    if (!tvdbEpisodeId || !/^\d+$/.test(tvdbEpisodeId)) return;
    const existing = this.episodeByTvdbId.get(tvdbEpisodeId);
    if (existing === undefined) {
      this.episodeByTvdbId.set(tvdbEpisodeId, { mediaId, episodeId });
    } else if (
      existing == null ||
      existing.mediaId !== mediaId ||
      existing.episodeId !== episodeId
    ) {
      this.episodeByTvdbId.set(tvdbEpisodeId, null);
    }
  }

  resolveEpisode(
    rawTvdbEpisodeId: string | number | null | undefined,
    expectedMediaId?: string | null,
  ): ArchiveEpisodeMatch | null {
    const tvdbEpisodeId = normalizeNumericExternalId(rawTvdbEpisodeId);
    if (!tvdbEpisodeId) return null;
    const match = this.episodeByTvdbId.get(tvdbEpisodeId) ?? null;
    if (!match || (expectedMediaId && match.mediaId !== expectedMediaId)) return null;
    return match;
  }

  resolveEpisodeCoordinate(
    rawTvdbEpisodeId: string | number | null | undefined,
  ): ArchiveEpisodeCoordinate | null {
    const tvdbEpisodeId = normalizeNumericExternalId(rawTvdbEpisodeId);
    if (!tvdbEpisodeId) return null;
    return this.episodeCoordinateByTvdbId.get(tvdbEpisodeId) ?? null;
  }

  private mergedEpisodeGroups(): Array<{
    showTitle: string;
    seriesId: string | null;
    season: number;
    episodeIds: Set<string>;
  }> {
    const merged = new Map<
      string,
      { showTitle: string; seriesId: string | null; season: number; episodeIds: Set<string> }
    >();
    for (const group of this.episodeIdsByShowSeason.values()) {
      const titleSeriesIds = this.seriesIdsFor(group.showTitle);
      const seriesId = group.seriesId ?? (titleSeriesIds.length === 1 ? titleSeriesIds[0] : null);
      const key = JSON.stringify([seriesId ?? normTitle(group.showTitle), group.season]);
      const combined = merged.get(key) ?? {
        showTitle: group.showTitle,
        seriesId,
        season: group.season,
        episodeIds: new Set<string>(),
      };
      for (const episodeId of group.episodeIds) combined.episodeIds.add(episodeId);
      merged.set(key, combined);
    }
    return [...merged.values()];
  }

  /**
   * Recover deleted TVDB aliases from coordinates repeated elsewhere in the archive. This only
   * maps an unknown id onto an episode number that already has authoritative positive evidence
   * for the same show and season. It supports a bounded hole (E3, unknown, E5) and an immediately
   * adjacent obsolete alias (old id immediately before/after E5); it never derives coordinates
   * from watch order or timestamps.
   */
  inferEpisodeCoordinatesFromArchiveSequence(): number {
    let inferred = 0;
    for (const group of this.mergedEpisodeGroups()) {
      const orderedIds = [...group.episodeIds]
        .filter((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)))
        .sort((a, b) => Number(a) - Number(b));
      const belongsToGroup = (coordinate: ArchiveEpisodeCoordinate): boolean => {
        if (coordinate.season !== group.season) return false;
        if (group.seriesId && coordinate.seriesId && group.seriesId !== coordinate.seriesId) {
          return false;
        }
        return Boolean(
          group.seriesId ||
          !coordinate.showTitle ||
          normTitle(coordinate.showTitle) === normTitle(group.showTitle),
        );
      };
      const authoritative = new Map<string, ArchiveEpisodeCoordinate>();
      for (const id of orderedIds) {
        const coordinate = this.episodeCoordinateByTvdbId.get(id);
        if (coordinate && belongsToGroup(coordinate)) authoritative.set(id, coordinate);
      }
      const authoritativeEpisodeNumbers = new Set(
        [...authoritative.values()].map((coordinate) => coordinate.episode),
      );
      const setInferred = (id: string, episode: number): boolean => {
        // An existing null is an explicit conflict and must remain ambiguous.
        if (this.episodeCoordinateByTvdbId.has(id) || !authoritativeEpisodeNumbers.has(episode)) {
          return false;
        }
        this.episodeCoordinateByTvdbId.set(id, {
          showTitle: group.showTitle,
          seriesId: group.seriesId,
          season: group.season,
          episode,
        });
        inferred++;
        return true;
      };

      // Fill a numeric-id hole only when its size exactly matches the missing episode range.
      const positionedById = [...authoritative.entries()].sort(
        ([left], [right]) => Number(left) - Number(right),
      );
      for (let index = 0; index < positionedById.length - 1; index++) {
        const [leftId, left] = positionedById[index];
        const [rightId, right] = positionedById[index + 1];
        if (right.episode <= left.episode) continue;
        const between = orderedIds.filter(
          (id) =>
            Number(id) > Number(leftId) &&
            Number(id) < Number(rightId) &&
            !this.episodeCoordinateByTvdbId.has(id),
        );
        if (right.episode - left.episode !== between.length + 1) continue;
        if (
          between.some((_, offset) => !authoritativeEpisodeNumbers.has(left.episode + offset + 1))
        ) {
          continue;
        }
        between.forEach((id, offset) => setInferred(id, left.episode + offset + 1));
      }

      // TVDB replacements often leave an obsolete id directly beside the previous/next id.
      // Accept that alias only when the inferred episode is independently present in the archive.
      for (const id of orderedIds) {
        if (this.episodeCoordinateByTvdbId.has(id)) continue;
        const numericId = Number(id);
        const candidates = new Set<number>();
        const before = authoritative.get(String(numericId - 1));
        const after = authoritative.get(String(numericId + 1));
        if (before && authoritativeEpisodeNumbers.has(before.episode + 1)) {
          candidates.add(before.episode + 1);
        }
        if (after && after.episode > 1 && authoritativeEpisodeNumbers.has(after.episode - 1)) {
          candidates.add(after.episode - 1);
        }
        if (candidates.size === 1) setInferred(id, [...candidates][0]);
      }

      // A second exported id set can represent the same complete regular season after TVDB
      // replaced every episode identity. Map it only when both archive-backed sets have the
      // same cardinality and the authoritative coordinates prove an exact E1..EN season.
      const remaining = orderedIds.filter((id) => !this.episodeCoordinateByTvdbId.has(id));
      const knownEpisodeNumbers = [...authoritativeEpisodeNumbers].sort((a, b) => a - b);
      if (
        remaining.length >= 3 &&
        remaining.length === knownEpisodeNumbers.length &&
        knownEpisodeNumbers.every((episode, index) => episode === index + 1)
      ) {
        remaining
          .sort((a, b) => Number(a) - Number(b))
          .forEach((id, index) => setInferred(id, index + 1));
      }
    }
    return inferred;
  }

  /**
   * Share one provider recovery attempt across every file in this import. The promise itself is
   * cached so concurrently resolved ratings/comments/votes wait for the same result; failures
   * also remain scoped to this archive instead of repeatedly waiting on a degraded provider.
   */
  recoverEpisodeOnce(
    rawTvdbEpisodeId: string | number | null | undefined,
    mediaId: string,
    recover: () => Promise<string | null>,
  ): Promise<string | null> {
    const tvdbEpisodeId = normalizeNumericExternalId(rawTvdbEpisodeId);
    if (!tvdbEpisodeId) return Promise.resolve(null);
    const existing = this.resolveEpisode(tvdbEpisodeId, mediaId);
    if (existing) return Promise.resolve(existing.episodeId);

    const key = `${mediaId}:${tvdbEpisodeId}`;
    const pending = this.episodeRecoveryByKey.get(key);
    if (pending) return pending;

    const recovery = Promise.resolve()
      .then(recover)
      .then((episodeId) => {
        if (episodeId) this.bindEpisode(tvdbEpisodeId, mediaId, episodeId);
        return episodeId;
      })
      .catch(() => null);
    this.episodeRecoveryByKey.set(key, recovery);
    return recovery;
  }
}
