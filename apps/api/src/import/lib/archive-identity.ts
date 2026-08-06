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

export type ArchiveMovieIdentity = {
  title: string;
  normTitle: string;
  year: number | null;
  uuid: string | null;
  key: string;
};

const SHOW_TITLE_FIELDS = new Set(['tv_show_name', 'series_name', 'show_name']);
const TVDB_SERIES_ID_FIELDS = new Set(['tv_show_id', 'series_id', 's_id']);
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
  private readonly movieEvidenceByUuid = new Map<
    string,
    { titles: Map<string, string>; years: Set<number> }
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
    const movieTitle = String(lowered['movie_name'] ?? lowered['movie_title'] ?? '').trim();
    if (movieTitle && movieTitle !== '<nil>') {
      const entityType = String(lowered['entity_type'] ?? '')
        .trim()
        .toLowerCase();
      const entityUuid =
        entityType === 'movie' ? normalizeArchiveUuid(lowered['entity_uuid']) : null;
      const movieUuid = entityUuid ?? normalizeArchiveUuid(lowered['uuid']);
      if (movieUuid) this.addMovieEvidence(movieTitle, movieUuid, yearFromRawRow(lowered));
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
    const canonicalTitle = evidenceTitles.length === 1 ? evidenceTitles[0][1] : inputTitle;
    const canonicalNorm = evidenceTitles.length === 1 ? evidenceTitles[0][0] : inputNorm;
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
}
