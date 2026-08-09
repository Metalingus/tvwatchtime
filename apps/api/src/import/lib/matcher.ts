import { Injectable, Logger, Optional } from '@nestjs/common';
import { EpisodeStructureState, StructureProvider, StructureReason } from '@prisma/client';
import {
  ExternalProvider,
  MediaType,
  ProviderEntityKind,
  type SupportedLocale,
} from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runInLanguage, currentLanguage } from '../../common/language.context';
import { MediaMetadataService } from '../../media-metadata/media-metadata.service';
import { TmdbProvider } from '../../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../../media-metadata/providers/tvdb.provider';
import { normTitle, normalizeNumericExternalId } from './inference';
import { isAnimeSignal } from '../../media-metadata/classification/anime-signal';
import { isProviderError } from '../../media-metadata/providers/shared/provider-errors';
import {
  STRUCTURE_RULE_VERSION,
  type StructureDecision,
} from '../../media-metadata/structure-authority.service';
import type { TraktIds } from './trakt/types';
import { DRAGON_BALL_MOVIES_LEGACY_GROUP } from './tvtime-legacy';
import { StructureRemapService } from '../../media-metadata/structure-remap.service';
import { HydrationQueue } from '../../media-metadata/hydration/hydration.queue';
import { MediaCanonicalizationService } from '../../media-metadata/media-canonicalization.service';

export type MovieReclassificationMatch = {
  mediaId: string;
  confidence: number;
  matchedTitle: string;
  /** The verified TVDB MOVIE id, when the recovery came through TVDB movie search. */
  tvdbId?: number;
  tmdbId: number;
};

export type NumberedMovieGroupMatch = {
  axis: 'season' | 'episode';
  moviesByCoordinate: Map<string, MovieReclassificationMatch>;
};

export function numberedMovieCoordinateKey(season: number, episode: number): string {
  return `${season}:${episode}`;
}

type MovieGroupCoordinate = { season: number; episode: number };

function sequentialMovieGroupLayout(coordinates: MovieGroupCoordinate[]): {
  axis: NumberedMovieGroupMatch['axis'];
  coordinates: MovieGroupCoordinate[];
  ordinals: number[];
} | null {
  const uniqueCoordinates = [
    ...new Map(
      coordinates
        .filter(({ season, episode }) => season > 0 && episode > 0)
        .map((coordinate) => [
          numberedMovieCoordinateKey(coordinate.season, coordinate.episode),
          coordinate,
        ]),
    ).values(),
  ];
  if (uniqueCoordinates.length < 2) return null;

  let axis: NumberedMovieGroupMatch['axis'] | null = null;
  let ordinals: number[] = [];
  if (uniqueCoordinates.every(({ season }) => season === 1)) {
    axis = 'episode';
    ordinals = uniqueCoordinates.map(({ episode }) => episode);
  } else if (uniqueCoordinates.every(({ episode }) => episode === 1)) {
    axis = 'season';
    ordinals = uniqueCoordinates.map(({ season }) => season);
  }
  if (!axis) return null;

  const sortedOrdinals = [...new Set(ordinals)].sort((a, b) => a - b);
  if (
    sortedOrdinals.length !== uniqueCoordinates.length ||
    sortedOrdinals.some((ordinal, index) => ordinal !== index + 1)
  ) {
    return null;
  }
  return { axis, coordinates: uniqueCoordinates, ordinals: sortedOrdinals };
}

/** Shared return shape of all media-matching entry points. */
type MediaMatch = {
  mediaId: string | null;
  confidence: number;
  matchedTitle: string | null;
  /** Set on unresolved TVDB-id matches: the id is provably dead (404) vs inconclusive. */
  dead?: boolean;
  /** A TV Time show identity that providers conclusively identify as a movie. */
  reclassifiedMovie?: MovieReclassificationMatch;
};

type ShowFootprintHint = {
  maxSeason?: number | null;
  seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
};

type LocalTitleCandidate = {
  id: string;
  title: string;
  popularity: number;
  show: {
    yearStart: number | null;
    originalTitle: string | null;
    seasonsCount: number;
    seasons: { number: number; episodeCount: number; isSpecial: boolean }[];
  } | null;
  movie: { releaseYear: number | null } | null;
};

export interface MatchResult {
  mediaId: string | null;
  episodeId: string | null;
  confidence: number;
  status: 'matched' | 'needs_review' | 'unmatched';
  matchedTitle: string | null;
}

export type MediaExternalIdRequest = {
  provider: ExternalProvider;
  providerEntityKind: ProviderEntityKind;
  value: string;
};

export type EpisodeExternalIdRequest = {
  mediaId: string;
  provider: ExternalProvider;
  value: string;
};

export type EpisodeParentExternalIdRequest = {
  provider: ExternalProvider;
  value: string;
};

export type EpisodeCoordinateRequest = {
  mediaId: string;
  season: number;
  episode: number;
};

const PREFETCH_CHUNK_SIZE = 5_000;
const MAX_EXTERNAL_MEDIA_CACHE_ENTRIES = 150_000;
const MAX_EPISODE_CACHE_ENTRIES = 300_000;
const MAX_EPISODE_PARENT_CACHE_ENTRIES = 300_000;
const MAX_TVDB_BATCH_FAILURE_ENTRIES = 10_000;

function chunks<T>(items: T[], size = PREFETCH_CHUNK_SIZE): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

/**
 * Pick among EXACT-title matches. When the import carries a year, only candidates within
 * ±1y are eligible (remakes share titles — the year is the real disambiguator); otherwise
 * the MOST RECENT candidate wins, because TMDB ranks by historical popularity, which
 * favors the classic over the remake the user usually means. Popularity breaks ties.
 */
function pickBestTitleMatch<
  T extends { title: string; year?: number | null; popularity?: number | null },
>(exactMatches: T[], importYear?: number | null): T | undefined {
  if (exactMatches.length === 0) return undefined;
  let pool = exactMatches;
  if (importYear != null) {
    const near = exactMatches.filter((c) => c.year != null && Math.abs(c.year - importYear) <= 1);
    if (near.length > 0) pool = near;
  }
  return [...pool].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.popularity ?? 0) - (a.popularity ?? 0),
  )[0];
}

/** Provider search results are localized, while TV Time often exports the original-language
 * movie/show title. TMDB supplies both; either exact normalized title is authoritative enough
 * to accept the provider result instead of downgrading the correct translation to 50%. */
function providerTitleMatches(
  candidate: { title: string; originalTitle?: string | null; aliases?: string[] },
  normalizedImportTitle: string,
): boolean {
  return [candidate.title, candidate.originalTitle, ...(candidate.aliases ?? [])].some(
    (title) => !!title && normTitle(title) === normalizedImportTitle,
  );
}

function hasShowFootprintHint(hint?: ShowFootprintHint | null): hint is ShowFootprintHint {
  return !!hint && (!!hint.maxSeason || !!hint.seasonEpisodes?.length);
}

/** A multi-episode TV Time identity may represent an OVA/miniseries or several TMDB movies.
 * It must never collapse into one movie. Watchlist-only rows and a single S1E1 footprint are
 * eligible for conservative cross-type title recovery. */
function canRepresentSingleMovie(hint?: ShowFootprintHint | null): boolean {
  if (!hasShowFootprintHint(hint)) return true;
  if ((hint.maxSeason ?? 0) > 1) return false;
  const seasons = hint.seasonEpisodes ?? [];
  return seasons.length <= 1 && seasons.every((season) => season.maxEpisode <= 1);
}

type TvdbAnimeTitleRelation = 'exact' | 'extended';

/**
 * TV Time can retain a descriptive arc suffix after TVDB replaces a legacy anime series
 * record ("Nekomonogatari (Black)" became "...: Tsubasa Family" in old exports). Exact
 * aliases remain preferred. A prefix relation is deliberately narrow and must later be
 * reinforced by an exact provider footprint before it can recover an identity.
 */
function tvdbAnimeTitleRelation(
  candidate: { title?: string | null; originalTitle?: string | null; aliases?: string[] },
  importedNorm: string,
): TvdbAnimeTitleRelation | null {
  const variants = [candidate.title, candidate.originalTitle, ...(candidate.aliases ?? [])]
    .map((value) => normTitle(value ?? ''))
    .filter(Boolean);
  if (variants.some((value) => value === importedNorm)) return 'exact';
  const extended = variants.some((value) => {
    const tokens = value.split(/\s+/).filter(Boolean);
    const importedTokens = importedNorm.split(/\s+/).filter(Boolean);
    return (
      value.length >= 12 &&
      tokens.length >= 2 &&
      importedTokens.length >= 1 &&
      (importedNorm.startsWith(`${value} `) || value.startsWith(`${importedNorm} `))
    );
  });
  return extended ? 'extended' : null;
}

function tvdbAnimeCollectionBaseNorm(importedNorm: string): string | null {
  const match = /^(.+?)\s+(?:ova|ovas|special|specials)$/.exec(importedNorm);
  const base = match?.[1]?.trim() ?? '';
  return base.length >= 8 && base.split(/\s+/).length >= 2 ? base : null;
}

function translationTitles(
  translations?: Record<string, { title?: string; overview?: string }> | null,
): string[] {
  return Object.values(translations ?? {})
    .map((translation) => translation.title?.trim())
    .filter((title): title is string => !!title);
}

function canonicalLegacyMovieNorm(title: string): string {
  return normTitle(title)
    .replace(/\bre surrection\b/g, 'resurrection')
    .replace(/\brevival\b/g, 'resurrection');
}

type StaleShowMovieRecoveryPlan = {
  queries: string[];
  acceptedNorms: string[];
  requireAnime: boolean;
};

function staleShowMovieRecoveryPlan(
  importedTitle: string,
  importedNorm: string,
): StaleShowMovieRecoveryPlan {
  const queries = [importedTitle];
  const acceptedNorms = [importedNorm];
  let requireAnime = false;

  // TV Time's deleted one-episode OVA identity used this English title, while both current
  // providers index the work only under its romanized Japanese name.
  if (importedNorm === 'i love my younger sister') {
    const alias = 'Boku wa Imouto ni Koi wo Suru';
    queries.push(alias);
    acceptedNorms.push(normTitle(alias));
    requireAnime = true;
  }

  // TV Time translated 復活 as "Revival"; TMDB uses "Re;surrection". Keep this synonym scoped
  // to the already-dead show→movie recovery branch and still require a unique provider movie.
  if (/\brevival\b/i.test(importedTitle)) {
    const alias = importedTitle.replace(/\brevival\b/gi, 'Resurrection');
    queries.push(alias);
    acceptedNorms.push(normTitle(alias));
  }

  return {
    queries: [...new Set(queries)],
    acceptedNorms: [...new Set(acceptedNorms)],
    requireAnime,
  };
}

function matchesStaleShowMovieTitle(titles: Array<string | null | undefined>, norms: string[]) {
  const accepted = new Set(norms.map(canonicalLegacyMovieNorm).filter(Boolean));
  return titles.some((title) => !!title && accepted.has(canonicalLegacyMovieNorm(title)));
}

function numberedMovieOrdinal(candidateTitle: string, importedNorm: string): number | null {
  const candidateNorm = normTitle(candidateTitle);
  if (!candidateNorm.startsWith(`${importedNorm} `)) return null;
  const suffix = candidateNorm.slice(importedNorm.length).trim();
  const match = /^(?:case|part|film|movie)\s+(\d+)(?:\s|$)/.exec(suffix);
  if (!match) return null;
  const ordinal = Number(match[1]);
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : null;
}

function unitaryMovieGroupBaseNorm(importedNorm: string): string {
  const withoutCollectionSuffix = importedNorm.replace(
    /\s+(?:movie|movies|film|films|movie collection|film collection)$/,
    '',
  );
  return withoutCollectionSuffix.split(/\s+/).length >= 2 ? withoutCollectionSuffix : importedNorm;
}

@Injectable()
export class ImportMatcher {
  private readonly logger = new Logger(ImportMatcher.name);
  private readonly mediaCache = new Map<
    string,
    {
      mediaId: string | null;
      confidence: number;
      title: string | null;
      dead?: boolean;
      reclassifiedMovie?: MovieReclassificationMatch;
    }
  >();
  private readonly episodeCache = new Map<string, string>();
  private readonly episodeParentCache = new Map<
    string,
    { mediaId: string; episodeId: string; title: string }
  >();
  private readonly externalMediaCache = new Map<
    string,
    { id: string; title: string; type: 'SHOW' | 'MOVIE' }
  >();
  private readonly showHydrationInFlight = new Map<string, Promise<void>>();
  private readonly verifiedCanonicalEpisodeAliases = new Set<string>();
  private readonly tvdbBatchUnavailableUntil = new Map<string, number>();
  /**
   * Shows whose current episode graph is known not to represent the importing provider.
   * ImportProcessor parks their episode-scoped rows until the queued authority job finishes.
   */
  private readonly structureEvaluationPending = new Set<string>();
  /**
   * Per-media provider preference for hydration: set to 'tvdb' when a match identified the
   * show as anime (TMDB anime season/episode structures are unreliable — TVDB is
   * authoritative). Consulted by ensureShowHydrated.
   */
  private readonly providerPref = new Map<string, 'tmdb' | 'tvdb'>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    @Optional() private readonly structureRemap?: StructureRemapService,
    @Optional() private readonly _hydrationQueue?: HydrationQueue,
    @Optional() private readonly canonical?: MediaCanonicalizationService,
  ) {}

  private canonicalEpisodeAliasKey(mediaId: string, value: string): string {
    return `${mediaId}:${value}`;
  }

  private markVerifiedCanonicalEpisodeAlias(mediaId: string, value: string): void {
    const key = this.canonicalEpisodeAliasKey(mediaId, value);
    if (this.verifiedCanonicalEpisodeAliases.has(key)) {
      this.verifiedCanonicalEpisodeAliases.delete(key);
    }
    this.verifiedCanonicalEpisodeAliases.add(key);
    while (this.verifiedCanonicalEpisodeAliases.size > MAX_EPISODE_CACHE_ENTRIES) {
      const oldest = this.verifiedCanonicalEpisodeAliases.values().next().value as
        string | undefined;
      if (!oldest) break;
      this.verifiedCanonicalEpisodeAliases.delete(oldest);
    }
  }

  /** Whether the complete show-level TVDB snapshot already evaluated this episode identity. */
  hasVerifiedTvdbEpisodeAlias(
    mediaId: string,
    rawValue: string | number | null | undefined,
  ): boolean {
    const value = normalizeNumericExternalId(rawValue);
    return value
      ? this.verifiedCanonicalEpisodeAliases.has(this.canonicalEpisodeAliasKey(mediaId, value))
      : false;
  }

  markStructureEvaluationPending(mediaId: string): void {
    this.structureEvaluationPending.add(mediaId);
  }

  clearStructureEvaluationPending(mediaId: string): void {
    this.structureEvaluationPending.delete(mediaId);
  }

  isStructureEvaluationPending(mediaId: string | null | undefined): boolean {
    return !!mediaId && this.structureEvaluationPending.has(mediaId);
  }

  private markTvdbBatchUnavailable(mediaId: string): void {
    if (this.tvdbBatchUnavailableUntil.has(mediaId)) {
      this.tvdbBatchUnavailableUntil.delete(mediaId);
    }
    this.tvdbBatchUnavailableUntil.set(mediaId, Date.now() + 60_000);
    while (this.tvdbBatchUnavailableUntil.size > MAX_TVDB_BATCH_FAILURE_ENTRIES) {
      const oldest = this.tvdbBatchUnavailableUntil.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tvdbBatchUnavailableUntil.delete(oldest);
    }
  }

  private isCanonicalActiveEpisode(episode: {
    structureState?: EpisodeStructureState;
    externalIds?: { provider: string }[];
    season: { show: { structureProvider?: StructureProvider | null } };
  }): boolean {
    if (episode.structureState && episode.structureState !== EpisodeStructureState.ACTIVE) {
      return false;
    }
    const owner = episode.season.show.structureProvider;
    // Older fixtures and rollout-era rows may not expose the typed owner. Preserve the existing
    // active-row behavior until an explicit authority exists.
    if (!owner || !Array.isArray(episode.externalIds)) return true;
    const providers = new Set(episode.externalIds.map((external) => String(external.provider)));
    return owner === StructureProvider.TVDB
      ? providers.has(ExternalProvider.THE_TVDB)
      : providers.has(ExternalProvider.TMDB);
  }

  private externalMediaKey(provider: string, providerEntityKind: string, value: string): string {
    return `${provider}:${providerEntityKind}:${value}`;
  }

  private setExternalMediaCache(
    key: string,
    value: { id: string; title: string; type: 'SHOW' | 'MOVIE' },
  ): void {
    if (this.externalMediaCache.has(key)) this.externalMediaCache.delete(key);
    this.externalMediaCache.set(key, value);
    while (this.externalMediaCache.size > MAX_EXTERNAL_MEDIA_CACHE_ENTRIES) {
      const oldest = this.externalMediaCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.externalMediaCache.delete(oldest);
    }
  }

  private setEpisodeCache(key: string, episodeId: string): void {
    if (this.episodeCache.has(key)) this.episodeCache.delete(key);
    this.episodeCache.set(key, episodeId);
    while (this.episodeCache.size > MAX_EPISODE_CACHE_ENTRIES) {
      const oldest = this.episodeCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.episodeCache.delete(oldest);
    }
  }

  private episodeParentKey(provider: ExternalProvider, value: string): string {
    return `${provider}:${value}`;
  }

  private setEpisodeParentCache(
    key: string,
    value: { mediaId: string; episodeId: string; title: string },
  ): void {
    if (this.episodeParentCache.has(key)) this.episodeParentCache.delete(key);
    this.episodeParentCache.set(key, value);
    while (this.episodeParentCache.size > MAX_EPISODE_PARENT_CACHE_ENTRIES) {
      const oldest = this.episodeParentCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.episodeParentCache.delete(oldest);
    }
  }

  private async findLocalMediaByExternalId(
    provider: ExternalProvider,
    providerEntityKind: ProviderEntityKind,
    value: string,
  ): Promise<{ id: string; title: string; type: 'SHOW' | 'MOVIE' } | null> {
    const key = this.externalMediaKey(provider, providerEntityKind, value);
    if (this.externalMediaCache.has(key)) return this.externalMediaCache.get(key)!;
    const ext = await this.prisma.externalId.findFirst({
      where: { provider, providerEntityKind, value },
      include: { media: true },
    });
    const media = ext?.media
      ? { id: ext.media.id, title: ext.media.title, type: ext.media.type }
      : null;
    if (media) this.setExternalMediaCache(key, media);
    return media;
  }

  /**
   * Load local media identities for an import in a handful of indexed queries. Only positive
   * results are retained because this service is shared by concurrent imports and provider
   * recovery can add a previously absent alias at any time.
   */
  async prefetchMediaExternalIds(requests: MediaExternalIdRequest[]): Promise<void> {
    const grouped = new Map<string, MediaExternalIdRequest[]>();
    for (const request of requests) {
      if (!request.value) continue;
      const groupKey = `${request.provider}:${request.providerEntityKind}`;
      const group = grouped.get(groupKey) ?? [];
      group.push(request);
      grouped.set(groupKey, group);
    }
    for (const group of grouped.values()) {
      const sample = group[0];
      const values = [...new Set(group.map((request) => request.value))];
      for (const valueChunk of chunks(values)) {
        const rows = await this.prisma.externalId.findMany({
          where: {
            provider: sample.provider,
            providerEntityKind: sample.providerEntityKind,
            value: { in: valueChunk },
          },
          include: { media: true },
        });
        for (const row of rows) {
          this.setExternalMediaCache(
            this.externalMediaKey(row.provider, row.providerEntityKind, row.value),
            { id: row.media.id, title: row.media.title, type: row.media.type },
          );
        }
      }
    }
  }

  /**
   * Resolve episode aliases globally, before a parent show has been selected. TVDB episode ids
   * are authoritative identities and already encode their parent show, so this prevents an
   * ambiguous title such as "Vikings" from selecting a different same-title series first.
   */
  async prefetchEpisodeParents(requests: EpisodeParentExternalIdRequest[]): Promise<void> {
    const grouped = new Map<ExternalProvider, string[]>();
    for (const request of requests) {
      if (!request.value) continue;
      const values = grouped.get(request.provider) ?? [];
      values.push(request.value);
      grouped.set(request.provider, values);
    }

    for (const [provider, rawValues] of grouped) {
      const values = [...new Set(rawValues)];
      for (const valueChunk of chunks(values)) {
        const rows = await this.prisma.episodeExternalId.findMany({
          where: {
            provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value: { in: valueChunk },
          },
          select: {
            value: true,
            episodeId: true,
            episode: {
              select: {
                structureState: true,
                externalIds: { select: { provider: true } },
                season: {
                  select: {
                    show: {
                      select: {
                        mediaId: true,
                        structureProvider: true,
                        media: { select: { title: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        });
        for (const row of rows) {
          if (!this.isCanonicalActiveEpisode(row.episode)) continue;
          const show = row.episode.season.show;
          this.setEpisodeParentCache(this.episodeParentKey(provider, row.value), {
            mediaId: show.mediaId,
            episodeId: row.episodeId,
            title: show.media.title,
          });
          this.setEpisodeCache(`ext-ep:${show.mediaId}:${provider}:${row.value}`, row.episodeId);
        }
      }
    }
  }

  /**
   * Return the one local parent shared by the supplied episode aliases. More than one parent is
   * an authoritative conflict and must remain reviewable; title matching must not break the tie.
   */
  matchPrefetchedShowByEpisodeIds(
    rawValues: Array<string | number | null | undefined>,
    provider: ExternalProvider = ExternalProvider.THE_TVDB,
  ): MediaMatch & { conflict: boolean; matchedAliasCount: number } {
    const parents = new Map<string, { title: string; count: number }>();
    for (const rawValue of rawValues) {
      const value = normalizeNumericExternalId(rawValue);
      if (!value) continue;
      const parent = this.episodeParentCache.get(this.episodeParentKey(provider, value));
      if (!parent) continue;
      const existing = parents.get(parent.mediaId);
      parents.set(parent.mediaId, {
        title: parent.title,
        count: (existing?.count ?? 0) + 1,
      });
    }

    const matchedAliasCount = [...parents.values()].reduce((sum, parent) => sum + parent.count, 0);
    if (parents.size === 1) {
      const [mediaId, parent] = [...parents.entries()][0];
      return {
        mediaId,
        confidence: 0.95,
        matchedTitle: parent.title,
        conflict: false,
        matchedAliasCount,
      };
    }
    return {
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      conflict: parents.size > 1,
      matchedAliasCount,
    };
  }

  /**
   * Prefer an exact local episode-owner identity over every coarser archive signal. Series/title
   * evidence can be ambiguous across same-title remakes; a TVDB episode alias belongs to exactly
   * one active local episode and therefore one parent show. Conflicting episode parents remain
   * reviewable and never invoke the fallback.
   */
  async matchShowWithEpisodeParent(
    rawEpisodeIds: Array<string | number | null | undefined>,
    fallback: () => Promise<MediaMatch>,
  ): Promise<MediaMatch & { conflict: boolean; matchedAliasCount: number }> {
    const episodeParent = this.matchPrefetchedShowByEpisodeIds(rawEpisodeIds);
    if (episodeParent.mediaId || episodeParent.conflict) return episodeParent;
    return { ...(await fallback()), conflict: false, matchedAliasCount: 0 };
  }

  /** Bulk-load imported episode aliases after the parent shows have been matched. */
  async prefetchEpisodeExternalIds(
    requests: EpisodeExternalIdRequest[],
    onProgress?: (completedMediaGroups: number, totalMediaGroups: number) => Promise<void> | void,
  ): Promise<void> {
    const grouped = new Map<ExternalProvider, EpisodeExternalIdRequest[]>();
    for (const request of requests) {
      if (!request.value) continue;
      const group = grouped.get(request.provider) ?? [];
      group.push(request);
      grouped.set(request.provider, group);
    }
    for (const [provider, group] of grouped) {
      const missing: EpisodeExternalIdRequest[] = [];
      for (const request of group) {
        const parent = this.episodeParentCache.get(this.episodeParentKey(provider, request.value));
        if (parent?.mediaId === request.mediaId) {
          this.setEpisodeCache(
            `ext-ep:${request.mediaId}:${provider}:${request.value}`,
            parent.episodeId,
          );
        } else if (!parent) {
          missing.push(request);
        }
      }
      const values = [...new Set(missing.map((request) => request.value))];
      for (const valueChunk of chunks(values)) {
        const rows = await this.prisma.episodeExternalId.findMany({
          where: {
            provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value: { in: valueChunk },
          },
          select: {
            provider: true,
            value: true,
            episodeId: true,
            episode: {
              select: {
                structureState: true,
                externalIds: { select: { provider: true } },
                season: {
                  select: {
                    show: { select: { mediaId: true, structureProvider: true } },
                  },
                },
              },
            },
          },
        });
        for (const row of rows) {
          if (!this.isCanonicalActiveEpisode(row.episode)) continue;
          const mediaId = row.episode.season.show.mediaId;
          this.setEpisodeCache(`ext-ep:${mediaId}:${row.provider}:${row.value}`, row.episodeId);
        }
      }

      // A TMDB-owned show may retain verified TVDB aliases on provider-foreign or quarantined
      // rows. Resolve every remaining alias for one media in one complete TVDB snapshot through
      // StructureRemap's read-only matching ladder. TVDB-owned anime/fallback shows are rejected
      // by that service and continue to use their canonical active TVDB structure.
      if (provider !== ExternalProvider.THE_TVDB) continue;
      const requestsByMedia = new Map<string, Map<string, EpisodeExternalIdRequest>>();
      for (const request of group) {
        const requests = requestsByMedia.get(request.mediaId) ?? new Map();
        requests.set(request.value, request);
        requestsByMedia.set(request.mediaId, requests);
      }
      for (const [mediaId, requestMap] of requestsByMedia) {
        const requests = [...requestMap.values()];
        const targets = requests.flatMap((request) => {
          const episodeId = this.episodeCache.get(`ext-ep:${mediaId}:${provider}:${request.value}`);
          return episodeId ? [episodeId] : [];
        });
        if (targets.length > 1 && new Set(targets).size < targets.length) {
          // Detect the collision even when both aliases were already attached locally.
          // Otherwise the direct DB fast path would bypass the complete-snapshot bridge.
          this.markStructureEvaluationPending(mediaId);
          for (const request of requests) {
            this.episodeCache.delete(`ext-ep:${mediaId}:${provider}:${request.value}`);
          }
        }
      }
      if (!this.structureRemap) continue;
      const mediaWithUnresolvedAliases = new Set<string>();
      for (const request of group) {
        const cacheKey = `ext-ep:${request.mediaId}:${provider}:${request.value}`;
        if (!this.episodeCache.has(cacheKey)) mediaWithUnresolvedAliases.add(request.mediaId);
      }
      const unresolvedByMedia = new Map<string, Set<string>>();
      for (const request of group) {
        if (!mediaWithUnresolvedAliases.has(request.mediaId)) continue;
        const cacheKey = `ext-ep:${request.mediaId}:${provider}:${request.value}`;
        // If one alias in a TMDB-owned show is missing, the show has proven that its provider
        // structures differ. Revalidate every imported alias in the same one-shot snapshot so an
        // older, coordinate-attached alias cannot silently bypass the bridge. Fully resolved shows
        // keep the direct DB fast path and incur no provider call.
        this.episodeCache.delete(cacheKey);
        const unresolved = unresolvedByMedia.get(request.mediaId) ?? new Set<string>();
        unresolved.add(request.value);
        unresolvedByMedia.set(request.mediaId, unresolved);
      }
      const mediaGroups = [...unresolvedByMedia.entries()];
      let completedMediaGroups = 0;
      for (const groupChunk of chunks(mediaGroups, 4)) {
        await Promise.all(
          groupChunk.map(async ([mediaId, unresolved]) => {
            try {
              const resolved = await this.structureRemap!.resolveTvdbEpisodeAliasesToCanonical(
                mediaId,
                [...unresolved],
              );
              this.tvdbBatchUnavailableUntil.delete(mediaId);
              for (const value of resolved.verifiedValues) {
                this.markVerifiedCanonicalEpisodeAlias(mediaId, value);
              }
              const verifiedButUnmapped = [...resolved.verifiedValues].filter(
                (value) => !resolved.mappings.has(value),
              );
              const mappedTargets = [...resolved.mappings.values()];
              const collapsedProviderEpisodes = new Set(mappedTargets).size < mappedTargets.length;
              const needsStructureEvaluation =
                verifiedButUnmapped.length > 0 ||
                (collapsedProviderEpisodes && !resolved.safeManyToOne);
              if (needsStructureEvaluation) {
                // Never cache a partial bridge or a large/weak collapse. Those rows wait for
                // the official authority job; terminal misses are later hidden as SKIPPED.
                this.markStructureEvaluationPending(mediaId);
              } else {
                // A complete, runtime/date-proven 2:1 bridge with a <=1 episode season delta
                // is safe to apply immediately (Lost S06E17/E18 -> TMDB combined finale).
                this.clearStructureEvaluationPending(mediaId);
                for (const [value, episodeId] of resolved.mappings) {
                  this.setEpisodeCache(
                    `ext-ep:${mediaId}:${ExternalProvider.THE_TVDB}:${value}`,
                    episodeId,
                  );
                }
              }
              if (resolved.mappings.size > 0) {
                this.logger.debug(
                  `Resolved ${resolved.mappings.size}/${unresolved.size} TVDB episode aliases for ${mediaId} through the canonical structure bridge`,
                );
              }
            } catch (error) {
              // One failed series snapshot must not fan out into one TVDB request per imported
              // episode. The short TTL permits a later import to retry after a transient outage.
              this.markTvdbBatchUnavailable(mediaId);
              this.logger.warn(
                `TVDB episode alias batch failed for ${mediaId}; preserving unresolved review state: ${(error as Error).message}`,
              );
            } finally {
              completedMediaGroups++;
              await Promise.resolve(onProgress?.(completedMediaGroups, mediaGroups.length)).catch(
                () => undefined,
              );
            }
          }),
        );
      }
    }
  }

  /**
   * Bulk-load active S/E coordinates once matching and hydration have finished. Duplicate
   * coordinates are deliberately not cached and retain resolveEpisode's review-safe behavior.
   */
  async prefetchEpisodeCoordinates(requests: EpisodeCoordinateRequest[]): Promise<void> {
    const wanted = new Set<string>();
    for (const request of requests) {
      const key = `${request.mediaId}:${request.season}:${request.episode}:s`;
      wanted.add(key);
    }
    const mediaIds = [...new Set(requests.map((request) => request.mediaId))];
    for (const mediaIdChunk of chunks(mediaIds)) {
      const rows = await this.prisma.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId: { in: mediaIdChunk } } },
        },
        select: {
          id: true,
          number: true,
          season: { select: { number: true, show: { select: { mediaId: true } } } },
        },
      });
      const coordinates = new Map<string, string | null>();
      for (const row of rows) {
        const key = `${row.season.show.mediaId}:${row.season.number}:${row.number}:s`;
        if (!wanted.has(key)) continue;
        coordinates.set(key, coordinates.has(key) ? null : row.id);
      }
      for (const [key, episodeId] of coordinates) {
        if (episodeId) this.setEpisodeCache(key, episodeId);
      }
    }
  }

  private pickLocalTitleCandidate(
    candidates: LocalTitleCandidate[],
    type: 'SHOW' | 'MOVIE',
    year?: number | null,
    hint?: ShowFootprintHint | null,
  ): LocalTitleCandidate | null {
    if (!candidates.length) return null;
    let pool = candidates;

    if (year != null) {
      const near = pool.filter((candidate) => {
        const candidateYear =
          type === 'SHOW' ? candidate.show?.yearStart : candidate.movie?.releaseYear;
        return candidateYear != null && Math.abs(candidateYear - year) <= 1;
      });
      // An explicit source year is identity evidence. If none of the local rows fit it, do not
      // silently discard it and pick a remake with the same name.
      if (!near.length) return null;
      pool = near;
    }

    if (type === 'SHOW' && hasShowFootprintHint(hint)) {
      const requiredSeason = hint.maxSeason ?? 0;
      pool = pool.filter((candidate) => {
        if (!candidate.show || candidate.show.seasonsCount < requiredSeason) return false;
        const episodeCounts = new Map(
          candidate.show.seasons
            .filter((season) => !season.isSpecial && season.number > 0)
            .map((season) => [season.number, season.episodeCount]),
        );
        return (hint.seasonEpisodes ?? []).every(
          ({ season, maxEpisode }) => (episodeCounts.get(season) ?? 0) >= maxEpisode,
        );
      });
      // A show that cannot contain the imported episodes is not a valid title match, even when
      // it is the only exact-title row in the catalog.
      if (!pool.length) return null;
      return [...pool].sort(
        (a, b) =>
          Math.max(0, (a.show?.seasonsCount ?? 0) - requiredSeason) -
            Math.max(0, (b.show?.seasonsCount ?? 0) - requiredSeason) ||
          b.popularity - a.popularity,
      )[0];
    }

    // A bare title with neither year nor structure cannot safely choose between remakes.
    if (pool.length > 1 && year == null) return null;
    return [...pool].sort((a, b) => b.popularity - a.popularity)[0];
  }

  private localTitleCandidateSelect() {
    return {
      id: true,
      title: true,
      popularity: true,
      show: {
        select: {
          yearStart: true,
          originalTitle: true,
          seasonsCount: true,
          seasons: {
            select: { number: true, episodeCount: true, isSpecial: true },
          },
        },
      },
      movie: { select: { releaseYear: true } },
    } as const;
  }

  private tvdbShowFitsImportFootprint(
    show: Awaited<ReturnType<TvdbProvider['getShow']>>,
    hint: ShowFootprintHint,
    requireExactEpisodeCounts = false,
  ): boolean {
    const maxSeason = hint.maxSeason ?? 0;
    const requiredEpisodes = new Map(
      (hint.seasonEpisodes ?? [])
        .filter(({ season, maxEpisode }) => season > 0 && maxEpisode > 0)
        .map(({ season, maxEpisode }) => [season, maxEpisode]),
    );
    if (maxSeason <= 0 || requiredEpisodes.size === 0) return false;

    const regularSeasons = (show.seasons ?? []).filter(
      (season) => !season.isSpecial && season.number > 0,
    );
    const candidateEpisodes = new Map(
      regularSeasons.map((season) => [season.number, season.episodeCount]),
    );
    const candidateMaxSeason = regularSeasons.reduce(
      (highest, season) => Math.max(highest, season.number),
      0,
    );
    const fits =
      candidateMaxSeason >= maxSeason &&
      [...requiredEpisodes].every(
        ([season, maxEpisode]) => (candidateEpisodes.get(season) ?? 0) >= maxEpisode,
      );
    if (
      !fits ||
      candidateMaxSeason !== maxSeason ||
      !regularSeasons.every((season) => requiredEpisodes.has(season.number))
    ) {
      return false;
    }
    return (
      !requireExactEpisodeCounts ||
      [...requiredEpisodes].every(
        ([season, maxEpisode]) => candidateEpisodes.get(season) === maxEpisode,
      )
    );
  }

  private tvdbShowHasImportSeasonRange(
    show: Awaited<ReturnType<TvdbProvider['getShow']>>,
    hint: ShowFootprintHint,
  ): boolean {
    const maxSeason = hint.maxSeason ?? 0;
    if (maxSeason <= 0) return false;
    const regularSeasonNumbers = (show.seasons ?? [])
      .filter((season) => !season.isSpecial && season.number > 0)
      .map((season) => season.number);
    return (
      regularSeasonNumbers.length > 0 &&
      Math.max(...regularSeasonNumbers) === maxSeason &&
      (hint.seasonEpisodes ?? []).every(({ season }) => regularSeasonNumbers.includes(season))
    );
  }

  private async tmdbAlternativeTitleMatches<
    T extends { tmdbId: number; title: string; originalTitle?: string | null; aliases?: string[] },
  >(type: 'SHOW' | 'MOVIE', candidates: T[], importedNorm: string): Promise<T[]> {
    const matches: T[] = [];
    for (const candidate of candidates.slice(0, 5)) {
      if (providerTitleMatches(candidate, importedNorm)) {
        matches.push(candidate);
        continue;
      }
      try {
        const aliases = await this.tmdb.getAlternativeTitles(type, candidate.tmdbId);
        if (providerTitleMatches({ ...candidate, aliases }, importedNorm)) matches.push(candidate);
      } catch (error) {
        this.logger.debug(
          `TMDB alternative-title lookup failed for ${type} ${candidate.tmdbId}: ${(error as Error).message}`,
        );
      }
    }
    return matches;
  }

  /**
   * Import-only exception for a replaced/deleted TVDB anime identity. This deliberately runs
   * only after every exported SERIES id is proven dead and only for a watched-show footprint or
   * an explicit legacy OVA/special collection suffix.
   * A direct TVDB candidate can own structure without TMDB /find when TVDB itself says Anime.
   * Every candidate needs the same complete regular-season range and enough episodes to contain
   * the imported activity. A weaker descriptive-prefix title additionally requires exact episode
   * counts. Search hits whose localized alias is omitted are verified again after a lightweight
   * translated TVDB hydrate. This rejects franchise parents while allowing a partially watched
   * final season.
   * More than one qualifying candidate is ambiguous and changes nothing.
   */
  private async recoverDeadTvdbAnimeSeries(
    title: string,
    importedNorm: string,
    year: number | null,
    hint: ShowFootprintHint | null | undefined,
  ): Promise<{ handled: boolean; match: MediaMatch | null }> {
    const hasFootprint = hasShowFootprintHint(hint);
    const collectionBaseNorm = tvdbAnimeCollectionBaseNorm(importedNorm);
    if (!this.tvdb.enabled || (!hasFootprint && !collectionBaseNorm)) {
      return { handled: false, match: null };
    }

    const colonBase = title.split(':', 1)[0]?.trim() ?? '';
    const collectionBaseTitle = collectionBaseNorm
      ? title.replace(/\s*[-:]?\s*(?:ovas?|specials?)\s*$/i, '').trim()
      : '';
    const searchQueries = [
      ...new Set(
        [title, colonBase, collectionBaseTitle].filter(
          (query) => query.length >= 8 && (query === title || normTitle(query) !== importedNorm),
        ),
      ),
    ];
    const candidatesByTvdbId = new Map<
      number,
      {
        candidate: Awaited<ReturnType<TvdbProvider['searchShows']>>['items'][number];
        relation: TvdbAnimeTitleRelation | null;
      }
    >();
    for (const query of searchQueries) {
      let search: Awaited<ReturnType<TvdbProvider['searchShows']>>;
      try {
        search = await this.tvdb.searchShows(query, 1);
      } catch (error) {
        this.logger.debug(
          `TVDB anime replacement search failed for "${query}": ${(error as Error).message}`,
        );
        return { handled: false, match: null };
      }
      for (const candidate of search.items) {
        const relation = tvdbAnimeTitleRelation(candidate, importedNorm);
        if (!candidate.tvdbId || candidatesByTvdbId.has(candidate.tvdbId)) continue;
        candidatesByTvdbId.set(candidate.tvdbId, { candidate, relation });
      }
    }
    const titleCandidates = [...candidatesByTvdbId.values()]
      .sort((a, b) => Number(!!b.relation) - Number(!!a.relation))
      .slice(0, 5);
    if (!titleCandidates.length) return { handled: false, match: null };

    const qualified: Array<{
      candidate: (typeof titleCandidates)[number]['candidate'];
      show: Awaited<ReturnType<TvdbProvider['getShow']>>;
    }> = [];
    for (const { candidate, relation: searchRelation } of titleCandidates) {
      try {
        const lightShow = await this.tvdb.getShow(candidate.tvdbId!, undefined, {
          includeStructure: false,
        });
        const relation =
          searchRelation ??
          tvdbAnimeTitleRelation(
            {
              title: lightShow.title,
              originalTitle: lightShow.originalTitle,
              aliases: translationTitles(lightShow.translations),
            },
            importedNorm,
          );
        if (!relation) continue;
        const anime = (lightShow.genres ?? []).some(
          (genre) => genre.name.trim().toLowerCase() === 'anime',
        );
        const candidateYear = lightShow.yearStart ?? candidate.year ?? null;
        const yearMatches =
          year == null || (candidateYear != null && Math.abs(candidateYear - year) <= 1);
        if (!anime || !yearMatches) continue;

        if (!hasFootprint) {
          const exactCollectionBase = [
            lightShow.title,
            lightShow.originalTitle,
            ...translationTitles(lightShow.translations),
            candidate.title,
            ...(candidate.aliases ?? []),
          ].some((candidateTitle) => normTitle(candidateTitle ?? '') === collectionBaseNorm);
          if (relation === 'extended' && exactCollectionBase) {
            qualified.push({ candidate, show: lightShow });
          }
          continue;
        }

        if (!this.tvdbShowHasImportSeasonRange(lightShow, hint)) continue;
        const show = await this.tvdb.getShow(candidate.tvdbId!);
        if (this.tvdbShowFitsImportFootprint(show, hint, relation === 'extended')) {
          qualified.push({ candidate, show });
        }
      } catch (error) {
        this.logger.debug(
          `TVDB anime replacement candidate ${candidate.tvdbId} failed for "${title}": ${(error as Error).message}`,
        );
      }
    }
    if (qualified.length !== 1) {
      if (qualified.length > 1) {
        this.logger.warn(
          `TVDB anime replacement for "${title}" is ambiguous across ${qualified.length} compatible series — preserving normal unresolved handling`,
        );
      }
      return { handled: false, match: null };
    }

    const [{ candidate, show }] = qualified;
    const tvdbId = candidate.tvdbId!;
    const decision: StructureDecision = {
      provider: StructureProvider.TVDB,
      reason: StructureReason.ANIME_TVDB,
      ruleVersion: STRUCTURE_RULE_VERSION,
      decidedAt: new Date(),
      tvdbId,
    };
    try {
      const mediaId = await this.meta.ensureShowFullTvdb(tvdbId, undefined, {
        forceRefresh: true,
        skipClassification: true,
        decision,
      });
      this.providerPref.set(mediaId, 'tvdb');
      this.logger.log(
        `Recovered dead TVDB anime identity "${title}" as TVDB series ${tvdbId} (${show.title}) with direct TVDB authority`,
      );
      return {
        handled: true,
        match: { mediaId, confidence: 0.9, matchedTitle: show.title },
      };
    } catch (error) {
      // Once TVDB itself proved this is the unique anime identity, never create a temporary
      // TMDB structure because the authoritative TVDB hydration happened to be unavailable.
      this.logger.warn(
        `Direct TVDB anime hydration failed for replacement ${tvdbId} ("${title}") — leaving it unresolved: ${(error as Error).message}`,
      );
      return { handled: true, match: null };
    }
  }

  /** Match a show or movie by title (+year). DB first, then TMDb (search + light-upsert). */
  /**
   * Resolve a title to a media id. Optional `hint` carries the import's observed seasons for a
   * show (highest season + highest episode number per season), used to disambiguate duplicate
   * titles (e.g. two shows "Silo"): among exact-title candidates the one that can actually
   * contain the import's seasons/episodes is preferred.
   */
  async matchMedia(
    norm: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    year?: number | null,
    hint?: ShowFootprintHint | null,
    archiveLanguage?: SupportedLocale | null,
    /**
     * Raw TVDB series id from a TV Time export (s_id/series_id/tv_show_id). When present,
     * this is the AUTHORITATIVE identity signal. A live or inconclusive ID never falls back
     * to a title. If every ID is confirmed dead, an exact provider title/year match is allowed,
     * but a fuzzy suggestion is never accepted for the unresolved identity.
     */
    rawTvdbSeriesId?: string | null,
    /**
     * ALL distinct TVDB series ids collected across duplicate rows of the same title
     * (TV Time sometimes carries two ids for one show after a TVDB merge — one dead, one
     * live). When present, each id is tried in order through the authority gate; title
     * fallback is refused only when EVERY id fails.
     */
    rawTvdbSeriesIds?: string[],
    /**
     * Set false by callers that have NO trustworthy title (e.g. list items whose only
     * identity is a TVDB id): when every id is dead, return null instead of title-matching
     * a placeholder string to an arbitrary show.
     */
    allowTitleFallback = true,
  ): Promise<MediaMatch> {
    let mayRecoverAsSingleMovie = false;
    let allAuthoritativeIdsDead = false;
    const rawIds = rawTvdbSeriesIds?.length
      ? rawTvdbSeriesIds
      : rawTvdbSeriesId
        ? [rawTvdbSeriesId]
        : [];
    const ids = [
      ...new Set(
        rawIds.map((id) => normalizeNumericExternalId(id)).filter((id): id is string => id != null),
      ),
    ].sort();
    const hintKey = hasShowFootprintHint(hint)
      ? JSON.stringify([
          hint.maxSeason ?? null,
          [...(hint.seasonEpisodes ?? [])].sort((a, b) => a.season - b.season),
        ])
      : '';
    const key = `${type}:${norm}:${year ?? ''}:${ids.join(',')}:${hintKey}:${archiveLanguage ?? ''}:${allowTitleFallback ? 'fallback' : 'strict'}`;
    const cached = this.mediaCache.get(key);
    if (cached)
      return {
        mediaId: cached.mediaId,
        confidence: cached.confidence,
        matchedTitle: cached.title,
        ...(cached.dead ? { dead: true } : {}),
        ...(cached.reclassifiedMovie ? { reclassifiedMovie: cached.reclassifiedMovie } : {}),
      };

    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;

    // ═══════════════════════════════════════════════════════════════════════════════
    // TVDB ID AUTHORITY GATE: when raw TVDB series IDs are present, they MUST be respected.
    // But TMDB is preferred for data quality — so we try TMDB first (exact /find) and only
    // fall back to TVDB. Title matching to a DIFFERENT show is FORBIDDEN; when every id is
    // confirmed dead, only an exact provider title can replace the stale identity.
    // ═══════════════════════════════════════════════════════════════════════════════

    if (ids.length) {
      const allowMovieReclassification = type !== 'SHOW' || canRepresentSingleMovie(hint);
      const r = await this.matchByTvdbIds(
        ids,
        title,
        type,
        year ?? null,
        allowMovieReclassification,
        hint,
      );
      if (r.reclassifiedMovie) {
        this.mediaCache.set(key, {
          mediaId: null,
          confidence: 0,
          title: null,
          reclassifiedMovie: r.reclassifiedMovie,
        });
        return r;
      }
      // Only all-ids-dead (404) falls through to title matching: stale export ids from a
      // TVDB merge carry no identity signal, while an inconclusive failure keeps the
      // refusal (we can't tell whether the id is live).
      if (r.mediaId || !r.allDead) {
        const result: MediaMatch = {
          mediaId: r.mediaId,
          confidence: r.confidence,
          matchedTitle: r.matchedTitle,
        };
        this.mediaCache.set(key, {
          mediaId: result.mediaId,
          confidence: result.confidence,
          title: result.matchedTitle,
        });
        return result;
      }
      if (!allowTitleFallback) {
        this.mediaCache.set(key, { mediaId: null, confidence: 0, title: null });
        return { mediaId: null, confidence: 0, matchedTitle: null };
      }
      mayRecoverAsSingleMovie = type === 'SHOW' && allowMovieReclassification;
      allAuthoritativeIdsDead = true;
      this.logger.log(
        `All ${ids.length} TVDB id(s) for "${title}" are dead or incompatible — trying exact title/year recovery`,
      );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TITLE MATCHING (no external ID, or exact-only recovery after confirmed-dead IDs)
    // ═══════════════════════════════════════════════════════════════════════════════

    // Never let punctuation-only/invalid titles share the empty normalized identity.
    if (!norm) return { mediaId: null, confidence: 0, matchedTitle: null };

    // 1) DB exact normalized matches. Never use findFirst here: duplicate titles are expected,
    // and database row order is not identity evidence.
    const exactCandidates = await this.prisma.mediaItem.findMany({
      where: { type: mediaType, normalizedTitle: norm },
      select: this.localTitleCandidateSelect(),
      take: 10,
    });
    const exact = this.pickLocalTitleCandidate(
      exactCandidates.filter((candidate) => normTitle(candidate.title) === norm),
      type,
      year,
      hint,
    );
    if (exact) {
      const confidence = 0.9;
      this.mediaCache.set(key, { mediaId: exact.id, confidence, title: exact.title });
      return { mediaId: exact.id, confidence, matchedTitle: exact.title };
    }

    // 2) DB contains match (normalized compare)
    const like = await this.prisma.mediaItem.findMany({
      where: { type: mediaType, title: { contains: title, mode: 'insensitive' } },
      select: this.localTitleCandidateSelect(),
      take: 10,
    });
    const normLike = this.pickLocalTitleCandidate(
      like.filter((candidate) => normTitle(candidate.title) === norm),
      type,
      year,
      hint,
    );
    if (normLike) {
      this.mediaCache.set(key, { mediaId: normLike.id, confidence: 0.8, title: normLike.title });
      return { mediaId: normLike.id, confidence: 0.8, matchedTitle: normLike.title };
    }

    // 2b) DB exact match on the "core" title (all parentheticals stripped).
    //     Catches variants like "The Office (US)" vs "The Office" without calling TMDb.
    const core = title
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (core && core.toLowerCase() !== title.toLowerCase()) {
      const coreCandidates = await this.prisma.mediaItem.findMany({
        where: { type: mediaType, normalizedTitle: normTitle(core) },
        select: this.localTitleCandidateSelect(),
        take: 10,
      });
      const coreMatch = this.pickLocalTitleCandidate(coreCandidates, type, year, hint);
      if (coreMatch) {
        const confidence = 0.85;
        this.mediaCache.set(key, { mediaId: coreMatch.id, confidence, title: coreMatch.title });
        return { mediaId: coreMatch.id, confidence, matchedTitle: coreMatch.title };
      }
    }

    // 2c) Indexed localized-title aliases — the database trigger projects titles JSON into
    //     searchable rows, avoiding a catalog-wide jsonb_each_text scan.
    const localizedCandidates = await this.prisma.mediaTitleAlias.findMany({
      where: {
        media: { type: mediaType },
        OR: [{ normalizedTitle: norm }, { title: { equals: title, mode: 'insensitive' } }],
      },
      select: { title: true, media: { select: this.localTitleCandidateSelect() } },
      take: 10,
    });
    const jsonMatchCandidates = localizedCandidates.filter(
      (candidate) => normTitle(candidate.title) === norm,
    );
    const jsonMedia = this.pickLocalTitleCandidate(
      [
        ...new Map(
          jsonMatchCandidates.map((candidate) => [candidate.media.id, candidate.media]),
        ).values(),
      ],
      type,
      year,
      hint,
    );
    const jsonMatch = jsonMedia
      ? jsonMatchCandidates.find((candidate) => candidate.media.id === jsonMedia.id)
      : null;
    if (jsonMatch) {
      const confidence = 0.85;
      this.mediaCache.set(key, {
        mediaId: jsonMatch.media.id,
        confidence,
        title: jsonMatch.media.title,
      });
      return {
        mediaId: jsonMatch.media.id,
        confidence,
        matchedTitle: jsonMatch.media.title,
      };
    }

    // Scoped exception: TV Time may retain a deleted TVDB anime id after TVDB creates a
    // replacement series. Existing exact local catalog identities always win. Only after those
    // miss can exactly one TVDB Anime series with the complete imported footprint route directly
    // through TVDB authority, without depending on TMDB /find.
    if (ids.length && type === 'SHOW') {
      const animeRecovery = await this.recoverDeadTvdbAnimeSeries(title, norm, year ?? null, hint);
      if (animeRecovery.handled) {
        const result =
          animeRecovery.match ??
          ({ mediaId: null, confidence: 0, matchedTitle: null } satisfies MediaMatch);
        this.mediaCache.set(key, {
          mediaId: result.mediaId,
          confidence: result.confidence,
          title: result.matchedTitle,
        });
        return result;
      }
    }

    // 3) TMDb search fallback
    if (this.tmdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tmdb.searchShows(title, 1)
            : await this.tmdb.searchMovies(title, 1);
        let exactMatches = res.items.filter((i) => providerTitleMatches(i, norm));
        if (allAuthoritativeIdsDead && exactMatches.length === 0) {
          exactMatches = await this.tmdbAlternativeTitleMatches(type, res.items, norm);
        }
        const hasHint = type === 'SHOW' && hasShowFootprintHint(hint);
        // A structural hint validates candidates; it is not merely a ranking boost. If no exact
        // title can contain the imported episodes, do not upsert an incompatible show.
        const best = hasHint
          ? await this.disambiguateShow(exactMatches, hint)
          : (pickBestTitleMatch(exactMatches, year) ?? (ids.length ? null : res.items[0]));
        if (best) {
          const sameTitle =
            providerTitleMatches(best, norm) ||
            exactMatches.some((candidate) => candidate.tmdbId === best.tmdbId);
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow(best)
              : await this.meta.lightUpsertMovie(best);
          const confidence = sameTitle ? 0.75 : 0.5;
          this.mediaCache.set(key, { mediaId, confidence, title: best.title });
          return { mediaId, confidence, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(`TMDb match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // 3b) TMDb archive-language fallback — retry in the archive (user.csv) language
    //     when the import-language search found nothing. The search + lightUpsert run
    //     inside the archive-language context so the override is stored under the right locale.
    if (archiveLanguage && archiveLanguage !== currentLanguage() && this.tmdb.enabled) {
      try {
        const found = await runInLanguage(archiveLanguage, async () => {
          const r =
            type === 'SHOW'
              ? await this.tmdb.searchShows(title, 1)
              : await this.tmdb.searchMovies(title, 1);
          const exactMatches = r.items.filter((i) => providerTitleMatches(i, norm));
          const b =
            type === 'SHOW' && hasShowFootprintHint(hint)
              ? await this.disambiguateShow(exactMatches, hint)
              : (pickBestTitleMatch(exactMatches, year) ?? (ids.length ? null : r.items[0]));
          if (!b) return null;
          const mid =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow(b)
              : await this.meta.lightUpsertMovie(b);
          return { mid, title: b.title, sameTitle: providerTitleMatches(b, norm) };
        });
        if (found) {
          const confidence = found.sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId: found.mid, confidence, title: found.title });
          return { mediaId: found.mid, confidence, matchedTitle: found.title };
        }
      } catch (e) {
        this.logger.warn(
          `TMDb archive-lang (${archiveLanguage}) match failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    // 4) TVDB fallback (backup provider) — used when TMDb has no/weak result.
    if (this.tvdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tvdb.searchShows(title, 1)
            : await this.tvdb.searchMovies(title, 1);
        const exactMatches = res.items.filter((i) => providerTitleMatches(i, norm));
        const best =
          type === 'SHOW' && hasShowFootprintHint(hint)
            ? await this.disambiguateTvdbShow(exactMatches, hint, ids.length > 0)
            : (pickBestTitleMatch(exactMatches, year) ?? (ids.length ? null : res.items[0]));
        if (best && best.tvdbId) {
          const sameTitle = providerTitleMatches(best, norm);
          const tvdbArgs = {
            tvdbId: best.tvdbId,
            title: best.title,
            overview: best.overview ?? null,
            posterUrl: best.posterUrl ?? null,
            backdropUrl: best.backdropUrl ?? null,
            popularity: best.popularity ?? 0,
            year: best.year ?? null,
            genres: best.providerGenres,
          };
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShowTvdb(tvdbArgs)
              : await this.meta.lightUpsertMovieTvdb(tvdbArgs);
          // Slightly more conservative than TMDb (it's a backup), but exact title → matched.
          const confidence = sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId, confidence, title: best.title });
          return { mediaId, confidence, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(`TVDB match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // TV Time historically represented some standalone movies as one-episode shows. Only
    // attempt the opposite kind after every exported SERIES id is confirmed stale, normal show
    // recovery failed, and the archive footprint can represent one movie. Multi-episode groups
    // (Kizumonogatari, Psycho-Pass: Sinners of the System, OVAs, etc.) remain unresolved rather
    // than being collapsed into one unrelated movie.
    if (mayRecoverAsSingleMovie) {
      const reclassifiedMovie = await this.recoverStaleShowIdentityAsMovie(
        title,
        norm,
        year ?? null,
      );
      if (reclassifiedMovie) {
        this.logger.log(
          `Recovered stale TVDB show identity "${title}" as verified movie ${reclassifiedMovie.matchedTitle} (TMDB ${reclassifiedMovie.tmdbId})`,
        );
        this.mediaCache.set(key, {
          mediaId: null,
          confidence: 0,
          title: null,
          reclassifiedMovie,
        });
        return {
          mediaId: null,
          confidence: 0,
          matchedTitle: null,
          dead: true,
          reclassifiedMovie,
        };
      }
    }

    // NOTE: Old Step 5 (TVDB exact-id recovery) was moved to Step 0b above.
    // When rawTvdbSeriesId is present, the TVDB authority gate (Step 0/0b/0c) handles
    // everything BEFORE any title matching. Title matching only runs when there's NO
    // external ID at all.

    return {
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      ...(allAuthoritativeIdsDead ? { dead: true } : {}),
    };
  }

  /**
   * Resolve-by-name matching (bulk manual resolve from the review UI). Like the title flow
   * of matchMedia but STRICT about the name: a candidate is accepted only when the source
   * title normalizes to its title, its original-language title, or one of its stored
   * localized titles (language aware — e.g. "7. Koğuştaki Mucize" matches the row whose
   * English title is "Miracle in Cell No. 7"). Show candidates are disambiguated by the
   * import's season/episode footprint (same approximation as the review UI's smart sort).
   * No id authority, no first-hit gambles — a non-matching name NEVER resolves.
   */
  async matchByTitleVerified(
    norm: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    hint?: ShowFootprintHint | null,
  ): Promise<{ mediaId: string | null; confidence: number; matchedTitle: string | null }> {
    if (!norm) return { mediaId: null, confidence: 0, matchedTitle: null };
    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;
    const nameMatches = (cand: {
      title?: string | null;
      originalTitle?: string | null;
      titles?: unknown;
    }): boolean => {
      if (cand.title && normTitle(cand.title) === norm) return true;
      if (cand.originalTitle && normTitle(cand.originalTitle) === norm) return true;
      if (cand.titles && typeof cand.titles === 'object') {
        return Object.values(cand.titles as Record<string, unknown>).some(
          (v) => normTitle(String(v)) === norm,
        );
      }
      return false;
    };

    // 1) Local catalog: base title OR original title OR localized titles JSON.
    const like = await this.prisma.mediaItem.findMany({
      where: {
        type: mediaType,
        OR: [
          { normalizedTitle: norm },
          { show: { originalTitle: { contains: title, mode: 'insensitive' } } },
        ],
      },
      take: 10,
      select: this.localTitleCandidateSelect(),
    });
    const dbHit = this.pickLocalTitleCandidate(
      like.filter((candidate) =>
        nameMatches({
          title: candidate.title,
          originalTitle: candidate.show?.originalTitle ?? null,
        }),
      ),
      type,
      null,
      hint,
    );
    if (dbHit) return { mediaId: dbHit.id, confidence: 0.85, matchedTitle: dbHit.title };

    // 1b) Indexed localized-title aliases (base title is another language).
    const localizedCandidates = await this.prisma.mediaTitleAlias.findMany({
      where: {
        media: { type: mediaType },
        OR: [{ normalizedTitle: norm }, { title: { equals: title, mode: 'insensitive' } }],
      },
      select: { title: true, media: { select: this.localTitleCandidateSelect() } },
      take: 10,
    });
    const verifiedAliases = localizedCandidates.filter((candidate) =>
      nameMatches({ title: candidate.title }),
    );
    const jsonMedia = this.pickLocalTitleCandidate(
      [
        ...new Map(
          verifiedAliases.map((candidate) => [candidate.media.id, candidate.media]),
        ).values(),
      ],
      type,
      null,
      hint,
    );
    const jsonHit = jsonMedia
      ? verifiedAliases.find((candidate) => candidate.media.id === jsonMedia.id)
      : null;
    if (jsonHit) {
      return { mediaId: jsonHit.media.id, confidence: 0.85, matchedTitle: jsonHit.media.title };
    }

    // 2) TMDB search — verified by title OR original-language title.
    if (this.tmdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tmdb.searchShows(title, 1)
            : await this.tmdb.searchMovies(title, 1);
        const verified = res.items.filter((i) => nameMatches(i));
        if (verified.length) {
          const best =
            type === 'SHOW' && hasShowFootprintHint(hint)
              ? await this.disambiguateShow(verified, hint)
              : pickBestTitleMatch(verified);
          if (best) {
            const mediaId =
              type === 'SHOW'
                ? await this.meta.lightUpsertShow(best)
                : await this.meta.lightUpsertMovie(best);
            return { mediaId, confidence: 0.85, matchedTitle: best.title };
          }
        }
      } catch (e) {
        this.logger.warn(
          `Resolve-by-name TMDb search failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    // 3) TVDB search (backup provider) — title-only check (TVDB has no separate original title).
    if (this.tvdb.enabled) {
      try {
        const res =
          type === 'SHOW'
            ? await this.tvdb.searchShows(title, 1)
            : await this.tvdb.searchMovies(title, 1);
        const verified = res.items.filter((i) => normTitle(i.title) === norm);
        const best =
          type === 'SHOW' && hasShowFootprintHint(hint)
            ? await this.disambiguateTvdbShow(verified, hint)
            : pickBestTitleMatch(verified);
        if (best && best.tvdbId) {
          const tvdbArgs = {
            tvdbId: best.tvdbId,
            title: best.title,
            overview: best.overview ?? null,
            posterUrl: best.posterUrl ?? null,
            backdropUrl: best.backdropUrl ?? null,
            popularity: best.popularity ?? 0,
            year: best.year ?? null,
            genres: best.providerGenres,
          };
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShowTvdb(tvdbArgs)
              : await this.meta.lightUpsertMovieTvdb(tvdbArgs);
          return { mediaId, confidence: 0.8, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(
          `Resolve-by-name TVDB search failed for "${title}": ${(e as Error).message}`,
        );
      }
    }

    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * TVDB-authority resolution (shared by the CSV rawTvdbSeriesId gate and the Trakt
   * external-id path): local TVDB mapping → exact TMDB /find translation → direct TVDB fetch.
   * NEVER falls back to title matching — an unresolvable id returns null/confidence 0.
   * Anime shows (TMDB Animation genre + `anime` keyword) are TVDB-authoritative: TMDB anime
   * season/episode structures are unreliable, so they get a TVDB-backed record + TVDB-first
   * hydration (providerPref), with the TMDB id still attached for cross-lookups.
   * The CALLER is responsible for caching the result.
   */
  private async validateTvdbMovieReclassification(
    tvdbId: number,
    importedTitle: string,
    importedYear: number | null,
    movie: Awaited<ReturnType<TvdbProvider['getMovie']>>,
    verifiedAliases: string[] = [],
    acceptedTitleNorms: string[] = [normTitle(importedTitle)],
    requireAnime = false,
  ): Promise<MovieReclassificationMatch | null> {
    if (!this.tmdb.enabled) return null;
    const tmdbValue = movie.externals.find((e) => e.provider === ExternalProvider.TMDB)?.value;
    const tmdbId = tmdbValue ? Number(tmdbValue) : NaN;
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;

    const tmdbMovie = await this.tmdb.getMovieRoutingProfile(tmdbId);
    const titleMatches = matchesStaleShowMovieTitle(
      [movie.title, tmdbMovie.title, ...verifiedAliases, ...translationTitles(movie.translations)],
      acceptedTitleNorms,
    );
    if (!titleMatches) return null;
    if (requireAnime && !isAnimeSignal(tmdbMovie.genreIds, tmdbMovie.keywords)) return null;

    if (importedYear != null) {
      const providerYears = [movie.releaseYear, tmdbMovie.releaseYear].filter(
        (candidate): candidate is number => candidate != null,
      );
      if (!providerYears.some((candidate) => Math.abs(candidate - importedYear) <= 1)) return null;
    }

    const imdbId = movie.externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
    const mediaId = await this.meta.lightUpsertMovieTvdb({
      tvdbId,
      tmdbId,
      imdbId: imdbId ?? tmdbMovie.imdbId ?? null,
      title: movie.title,
      overview: movie.overview ?? null,
      posterUrl: movie.posterUrl ?? null,
      backdropUrl: movie.backdropUrl ?? null,
      popularity: movie.popularity ?? 0,
      year: movie.releaseYear ?? tmdbMovie.releaseYear ?? null,
    });
    return {
      mediaId,
      confidence: 0.95,
      matchedTitle: tmdbMovie.title || movie.title,
      tvdbId,
      tmdbId,
    };
  }

  /**
   * Cross-type recovery for a stale TVDB SERIES identity that can represent exactly one movie.
   * The stale series number is never reused as a movie id here. Resolution starts from the
   * imported title and accepts only one provider-verified local/alternative-title candidate.
   * The selected movie must still expose a real TMDB movie cross-id before it is persisted.
   */
  private async recoverStaleShowIdentityAsMovie(
    importedTitle: string,
    importedNorm: string,
    importedYear: number | null,
  ): Promise<MovieReclassificationMatch | null> {
    const plan = staleShowMovieRecoveryPlan(importedTitle, importedNorm);
    const yearMatches = (candidateYear: number | null | undefined): boolean =>
      importedYear == null ||
      (candidateYear != null && Math.abs(candidateYear - importedYear) <= 1);

    const localCandidates = await this.prisma.mediaItem.findMany({
      where: {
        type: MediaType.MOVIE,
        OR: [
          { normalizedTitle: importedNorm },
          { titleAliases: { some: { normalizedTitle: importedNorm } } },
        ],
      },
      select: {
        id: true,
        title: true,
        movie: { select: { releaseYear: true } },
        titleAliases: {
          where: { normalizedTitle: importedNorm },
          select: { title: true },
        },
        externalIds: {
          where: {
            providerEntityKind: ProviderEntityKind.MOVIE,
            provider: { in: [ExternalProvider.TMDB, ExternalProvider.THE_TVDB] },
          },
          select: { provider: true, value: true },
        },
      },
      take: 10,
    });
    const exactLocal = localCandidates.filter(
      (candidate) =>
        yearMatches(candidate.movie?.releaseYear) &&
        [candidate.title, ...candidate.titleAliases.map((alias) => alias.title)].some(
          (candidateTitle) => normTitle(candidateTitle) === importedNorm,
        ),
    );
    if (exactLocal.length === 1) {
      const candidate = exactLocal[0];
      const tmdbValue = candidate.externalIds.find(
        (external) => external.provider === ExternalProvider.TMDB,
      )?.value;
      const tmdbId = tmdbValue ? Number(tmdbValue) : NaN;
      if (Number.isSafeInteger(tmdbId) && tmdbId > 0) {
        const tvdbValue = candidate.externalIds.find(
          (external) => external.provider === ExternalProvider.THE_TVDB,
        )?.value;
        const tvdbId = tvdbValue ? Number(tvdbValue) : NaN;
        return {
          mediaId: candidate.id,
          confidence: 0.9,
          matchedTitle: candidate.title,
          ...(Number.isSafeInteger(tvdbId) && tvdbId > 0 ? { tvdbId } : {}),
          tmdbId,
        };
      }
    }

    if (this.tvdb.enabled && this.tmdb.enabled) {
      try {
        const candidatesByTvdbId = new Map<
          number,
          Awaited<ReturnType<TvdbProvider['searchMovies']>>['items'][number]
        >();
        for (const query of plan.queries) {
          const result = await this.tvdb.searchMovies(query, 1);
          for (const candidate of result.items) {
            if (candidate.tvdbId && !candidatesByTvdbId.has(candidate.tvdbId)) {
              candidatesByTvdbId.set(candidate.tvdbId, candidate);
            }
          }
        }
        const validatedCandidates: MovieReclassificationMatch[] = [];
        for (const candidate of [...candidatesByTvdbId.values()].slice(0, 5)) {
          if (!candidate.tvdbId || !yearMatches(candidate.year)) continue;
          const movie = await this.tvdb.getMovie(candidate.tvdbId!);
          const validated = await this.validateTvdbMovieReclassification(
            candidate.tvdbId!,
            importedTitle,
            importedYear,
            movie,
            [candidate.title, ...(candidate.aliases ?? [])],
            plan.acceptedNorms,
            plan.requireAnime,
          );
          if (validated) validatedCandidates.push(validated);
        }
        const unique = new Map(
          validatedCandidates.map((candidate) => [candidate.mediaId, candidate]),
        );
        if (unique.size === 1) return [...unique.values()][0];
      } catch (error) {
        this.logger.debug(
          `TVDB movie-title recovery failed for "${importedTitle}": ${(error as Error).message}`,
        );
      }
    }

    // If the local catalog already has several exact movies and the archive has no year, a
    // TMDB exact result can still be the wrong same-title movie (A Silent Voice has a real-world
    // example). Require local non-ambiguity before using TMDB search as the final fallback.
    if (this.tmdb.enabled && (exactLocal.length <= 1 || importedYear != null)) {
      try {
        const candidatesByTmdbId = new Map<
          number,
          Awaited<ReturnType<TmdbProvider['searchMovies']>>['items'][number]
        >();
        for (const query of plan.queries) {
          const result = await this.tmdb.searchMovies(query, 1);
          for (const candidate of result.items) {
            if (candidate.tmdbId > 0 && !candidatesByTmdbId.has(candidate.tmdbId)) {
              candidatesByTmdbId.set(candidate.tmdbId, candidate);
            }
          }
        }
        const qualified = [] as Array<
          Awaited<ReturnType<TmdbProvider['searchMovies']>>['items'][number]
        >;
        for (const candidate of [...candidatesByTmdbId.values()].slice(0, 5)) {
          if (!yearMatches(candidate.year)) continue;
          const directTitles = [
            candidate.title,
            candidate.originalTitle,
            ...(candidate.aliases ?? []),
          ];
          let titleMatches = matchesStaleShowMovieTitle(directTitles, plan.acceptedNorms);
          if (!titleMatches) {
            const alternativeTitles = await this.tmdb.getAlternativeTitles(
              'MOVIE',
              candidate.tmdbId,
            );
            titleMatches = matchesStaleShowMovieTitle(
              [...directTitles, ...alternativeTitles],
              plan.acceptedNorms,
            );
          }
          if (!titleMatches) {
            continue;
          }
          if (plan.requireAnime) {
            const profile = await this.tmdb.getMovieRoutingProfile(candidate.tmdbId);
            if (!isAnimeSignal(profile.genreIds, profile.keywords)) continue;
          }
          qualified.push(candidate);
        }
        if (qualified.length === 1) {
          const candidate = qualified[0];
          const mediaId = await this.meta.lightUpsertMovie(candidate);
          return {
            mediaId,
            confidence: 0.85,
            matchedTitle: candidate.title,
            tmdbId: candidate.tmdbId,
          };
        }
      } catch (error) {
        this.logger.debug(
          `TMDB movie-title recovery failed for "${importedTitle}": ${(error as Error).message}`,
        );
      }
    }

    return null;
  }

  /**
   * TV Time occasionally models a numbered film cycle as one synthetic show. Resolve that shape
   * only from the already-hydrated local movie catalog and only when both sides prove the complete
   * ordinal sequence. Examples: Psycho-Pass S1E1..E3 -> Case.1..Case.3 and Kizumonogatari
   * S1E1/S2E1/S3E1 -> Part 1..Part 3. Missing or ambiguous ordinals fail closed.
   */
  async matchNumberedMovieGroup(
    importedTitle: string,
    coordinates: Array<{ season: number; episode: number }>,
  ): Promise<NumberedMovieGroupMatch | null> {
    const importedNorm = normTitle(importedTitle);
    if (!importedNorm) return null;
    const layout = sequentialMovieGroupLayout(coordinates);
    if (!layout) return null;
    const { axis, coordinates: uniqueCoordinates, ordinals: sortedOrdinals } = layout;

    const candidates = await this.prisma.mediaItem.findMany({
      where: {
        type: MediaType.MOVIE,
        OR: [
          { normalizedTitle: { startsWith: importedNorm } },
          { titleAliases: { some: { normalizedTitle: { startsWith: importedNorm } } } },
        ],
      },
      select: {
        id: true,
        title: true,
        titleAliases: {
          where: { normalizedTitle: { startsWith: importedNorm } },
          select: { title: true },
        },
        externalIds: {
          where: {
            provider: ExternalProvider.TMDB,
            providerEntityKind: ProviderEntityKind.MOVIE,
          },
          select: { value: true },
        },
      },
      take: 50,
    });

    const candidatesByOrdinal = new Map<number, MovieReclassificationMatch[]>();
    for (const candidate of candidates) {
      const ordinalEvidence = new Set(
        [candidate.title, ...candidate.titleAliases.map((alias) => alias.title)]
          .map((title) => numberedMovieOrdinal(title, importedNorm))
          .filter((ordinal): ordinal is number => ordinal != null),
      );
      if (ordinalEvidence.size !== 1) continue;
      const ordinal = [...ordinalEvidence][0];
      if (!sortedOrdinals.includes(ordinal)) continue;
      const tmdbValue = candidate.externalIds[0]?.value;
      const tmdbId = tmdbValue ? Number(tmdbValue) : NaN;
      if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) continue;
      const matches = candidatesByOrdinal.get(ordinal) ?? [];
      matches.push({
        mediaId: candidate.id,
        confidence: 0.95,
        matchedTitle: candidate.title,
        tmdbId,
      });
      candidatesByOrdinal.set(ordinal, matches);
    }
    if (sortedOrdinals.some((ordinal) => candidatesByOrdinal.get(ordinal)?.length !== 1)) {
      return null;
    }

    const moviesByCoordinate = new Map<string, MovieReclassificationMatch>();
    for (const coordinate of uniqueCoordinates) {
      const ordinal = axis === 'episode' ? coordinate.episode : coordinate.season;
      moviesByCoordinate.set(
        numberedMovieCoordinateKey(coordinate.season, coordinate.episode),
        candidatesByOrdinal.get(ordinal)![0],
      );
    }
    this.logger.log(
      `Recovered TV Time numbered movie group "${importedTitle}" as ${moviesByCoordinate.size} local TMDB movies`,
    );
    return { axis, moviesByCoordinate };
  }

  /**
   * TV Time also exports some film cycles as an is_unitary show without numbers in the movie
   * titles (Harry Potter is S1E1..S8E1, while the real films use subtitles). Resolve that shape
   * from movies already proven elsewhere in the SAME archive, ordered by authoritative release
   * date. If the archive carries no movie rows, a narrowly named "... Movies/Films" group may
   * use its TVDB episode titles to find exact, already-hydrated local movies. Any incomplete,
   * duplicate, same-date, or non-exact evidence fails closed.
   */
  async matchUnitaryMovieGroup(
    importedTitle: string,
    coordinates: Array<{ season: number; episode: number }>,
    archiveMovieMediaIds: string[],
    rawTvdbSeriesIds: string[] = [],
    language?: SupportedLocale | null,
  ): Promise<NumberedMovieGroupMatch | null> {
    const importedNorm = normTitle(importedTitle);
    const layout = sequentialMovieGroupLayout(coordinates);
    if (!importedNorm || !layout) return null;
    const baseNorm = unitaryMovieGroupBaseNorm(importedNorm);

    type MovieCandidate = {
      id: string;
      title: string;
      normalizedTitle: string;
      titleAliases: Array<{ title: string; normalizedTitle: string }>;
      movie: { releaseDate: Date | null; releaseYear: number | null } | null;
      externalIds: Array<{ value: string }>;
    };
    const toMatch = (candidate: MovieCandidate): MovieReclassificationMatch | null => {
      const tmdbValue = candidate.externalIds[0]?.value;
      const tmdbId = tmdbValue ? Number(tmdbValue) : NaN;
      return Number.isSafeInteger(tmdbId) && tmdbId > 0
        ? {
            mediaId: candidate.id,
            confidence: 0.95,
            matchedTitle: candidate.title,
            tmdbId,
          }
        : null;
    };
    const mapOrdered = (ordered: MovieCandidate[]): NumberedMovieGroupMatch | null => {
      if (ordered.length !== layout.coordinates.length) return null;
      const matches = ordered.map(toMatch);
      if (matches.some((match) => !match)) return null;
      const moviesByCoordinate = new Map<string, MovieReclassificationMatch>();
      for (const coordinate of layout.coordinates) {
        const ordinal = layout.axis === 'episode' ? coordinate.episode : coordinate.season;
        moviesByCoordinate.set(
          numberedMovieCoordinateKey(coordinate.season, coordinate.episode),
          matches[ordinal - 1]!,
        );
      }
      return { axis: layout.axis, moviesByCoordinate };
    };

    // TVDB deleted the old synthetic "Dragon Ball Movies" series and all of its episode
    // records, so the provider-title fallback below can no longer recover it. TV Time's
    // archived identity and exact 13-coordinate footprint still provide a stable mapping to
    // the original 13 Dragon Ball Z theatrical films. Require every signal and every canonical
    // TMDB movie locally; any missing or duplicate identity fails closed.
    const legacyGroup = DRAGON_BALL_MOVIES_LEGACY_GROUP;
    const normalizedSeriesIds = [
      ...new Set(rawTvdbSeriesIds.map(normalizeNumericExternalId).filter(Boolean)),
    ];
    if (
      importedNorm === legacyGroup.normalizedTitle &&
      normalizedSeriesIds.length === 1 &&
      normalizedSeriesIds[0] === legacyGroup.tvdbSeriesId &&
      layout.axis === legacyGroup.axis &&
      layout.coordinates.length === legacyGroup.tmdbMovieIds.length &&
      layout.coordinates.every(({ season }) => season === legacyGroup.season)
    ) {
      const tmdbValues = legacyGroup.tmdbMovieIds.map(String);
      const candidates = (await this.prisma.mediaItem.findMany({
        where: {
          type: MediaType.MOVIE,
          externalIds: {
            some: {
              provider: ExternalProvider.TMDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: { in: tmdbValues },
            },
          },
        },
        select: {
          id: true,
          title: true,
          normalizedTitle: true,
          titleAliases: { select: { title: true, normalizedTitle: true } },
          movie: { select: { releaseDate: true, releaseYear: true } },
          externalIds: {
            where: {
              provider: ExternalProvider.TMDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: { in: tmdbValues },
            },
            select: { value: true },
          },
        },
      })) as MovieCandidate[];
      const byTmdbId = new Map<string, MovieCandidate[]>();
      for (const candidate of candidates) {
        for (const externalId of candidate.externalIds) {
          const matches = byTmdbId.get(externalId.value) ?? [];
          matches.push(candidate);
          byTmdbId.set(externalId.value, matches);
        }
      }
      if (tmdbValues.every((value) => byTmdbId.get(value)?.length === 1)) {
        const match = mapOrdered(tmdbValues.map((value) => byTmdbId.get(value)![0]));
        if (match) {
          this.logger.log(
            `Recovered legacy TV Time movie group "${importedTitle}" as ${match.moviesByCoordinate.size} canonical TMDB movies`,
          );
          return match;
        }
      }
    }

    const uniqueArchiveIds = [...new Set(archiveMovieMediaIds.filter(Boolean))];
    if (uniqueArchiveIds.length >= layout.coordinates.length) {
      const archiveCandidates = (await this.prisma.mediaItem.findMany({
        where: { id: { in: uniqueArchiveIds }, type: MediaType.MOVIE },
        select: {
          id: true,
          title: true,
          normalizedTitle: true,
          titleAliases: { select: { title: true, normalizedTitle: true } },
          movie: { select: { releaseDate: true, releaseYear: true } },
          externalIds: {
            where: {
              provider: ExternalProvider.TMDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
            },
            select: { value: true },
          },
        },
      })) as MovieCandidate[];
      const related = archiveCandidates.filter((candidate) =>
        [candidate.normalizedTitle, ...candidate.titleAliases.map((alias) => alias.normalizedTitle)]
          .filter(Boolean)
          .some((title) => title === baseNorm || title.startsWith(`${baseNorm} `)),
      );
      if (related.length === layout.coordinates.length) {
        const sortable = related.map((candidate) => ({
          candidate,
          year:
            candidate.movie?.releaseYear ?? candidate.movie?.releaseDate?.getUTCFullYear() ?? null,
          timestamp: candidate.movie?.releaseDate?.getTime() ?? null,
        }));
        if (sortable.every(({ year }) => year != null)) {
          const duplicateYears = new Set(
            sortable
              .filter(
                ({ year }, index, all) => all.findIndex((other) => other.year === year) !== index,
              )
              .map(({ year }) => year),
          );
          const ambiguousSameYear = [...duplicateYears].some((year) => {
            const sameYear = sortable.filter((candidate) => candidate.year === year);
            return (
              sameYear.some(({ timestamp }) => timestamp == null) ||
              new Set(sameYear.map(({ timestamp }) => timestamp)).size !== sameYear.length
            );
          });
          if (!ambiguousSameYear) {
            const ordered = [...sortable]
              .sort(
                (a, b) =>
                  (a.timestamp ?? Date.UTC(a.year!, 0, 1)) -
                    (b.timestamp ?? Date.UTC(b.year!, 0, 1)) ||
                  a.candidate.title.localeCompare(b.candidate.title),
              )
              .map(({ candidate }) => candidate);
            const match = mapOrdered(ordered);
            if (match) {
              this.logger.log(
                `Recovered TV Time unitary movie group "${importedTitle}" from ${ordered.length} archive-proven movies`,
              );
              return match;
            }
          }
        }
      }
    }

    // This provider fallback is intentionally narrow: a generic unitary TV series (or a recut
    // season exported as its own show) must never be converted merely because episode titles
    // resemble movies.
    if (!/(?:^|\s)(?:movies|films)$/.test(importedNorm) || !this.tvdb.enabled) return null;
    const seriesIds = [
      ...new Set(rawTvdbSeriesIds.map(normalizeNumericExternalId).filter(Boolean)),
    ];
    if (seriesIds.length !== 1) return null;
    try {
      const show = await this.tvdb.getShow(Number(seriesIds[0]), language ?? undefined);
      const titlesByCoordinate = new Map<string, string>();
      for (const season of show.seasons) {
        for (const episode of season.episodes) {
          const title = episode.title.trim();
          if (title) {
            titlesByCoordinate.set(
              numberedMovieCoordinateKey(season.number, episode.number),
              title,
            );
          }
        }
      }
      const orderedTitles = layout.coordinates
        .map((coordinate) => ({
          coordinate,
          title: titlesByCoordinate.get(
            numberedMovieCoordinateKey(coordinate.season, coordinate.episode),
          ),
        }))
        .sort((a, b) => {
          const left = layout.axis === 'episode' ? a.coordinate.episode : a.coordinate.season;
          const right = layout.axis === 'episode' ? b.coordinate.episode : b.coordinate.season;
          return left - right;
        });
      if (orderedTitles.some(({ title }) => !title)) return null;
      const titleNorms = [...new Set(orderedTitles.map(({ title }) => normTitle(title!)))];
      if (titleNorms.length !== layout.coordinates.length) return null;
      const localCandidates = (await this.prisma.mediaItem.findMany({
        where: {
          type: MediaType.MOVIE,
          OR: [
            { normalizedTitle: { in: titleNorms } },
            { titleAliases: { some: { normalizedTitle: { in: titleNorms } } } },
          ],
        },
        select: {
          id: true,
          title: true,
          normalizedTitle: true,
          titleAliases: { select: { title: true, normalizedTitle: true } },
          movie: { select: { releaseDate: true, releaseYear: true } },
          externalIds: {
            where: {
              provider: ExternalProvider.TMDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
            },
            select: { value: true },
          },
        },
      })) as MovieCandidate[];
      const orderedCandidates: MovieCandidate[] = [];
      for (const normalizedTitle of titleNorms) {
        const exact = localCandidates.filter((candidate) =>
          [
            candidate.normalizedTitle,
            ...candidate.titleAliases.map((alias) => alias.normalizedTitle),
          ]
            .filter(Boolean)
            .includes(normalizedTitle),
        );
        if (
          exact.length !== 1 ||
          orderedCandidates.some((candidate) => candidate.id === exact[0].id)
        ) {
          return null;
        }
        orderedCandidates.push(exact[0]);
      }
      const match = mapOrdered(orderedCandidates);
      if (match) {
        this.logger.log(
          `Recovered TV Time unitary movie group "${importedTitle}" from exact TVDB episode titles`,
        );
      }
      return match;
    } catch (error) {
      this.logger.debug(
        `TVDB unitary movie-group recovery failed for "${importedTitle}": ${(error as Error).message}`,
      );
      return null;
    }
  }

  private async localTvdbMovieReclassification(
    rawTvdbId: string,
    importedTitle: string,
    importedYear: number | null,
  ): Promise<MovieReclassificationMatch | null> {
    const localMovie = await this.findLocalMediaByExternalId(
      ExternalProvider.THE_TVDB,
      ProviderEntityKind.MOVIE,
      rawTvdbId,
    );
    if (!localMovie || localMovie.type !== MediaType.MOVIE) return null;
    const tmdbExternal = await this.prisma.externalId.findFirst({
      where: {
        mediaId: localMovie.id,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.MOVIE,
      },
      select: {
        value: true,
        media: { select: { movie: { select: { releaseYear: true } } } },
      },
    });
    const tmdbId = tmdbExternal?.value ? Number(tmdbExternal.value) : NaN;
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return null;
    if (normTitle(localMovie.title) !== normTitle(importedTitle)) return null;
    if (
      importedYear != null &&
      (tmdbExternal?.media?.movie?.releaseYear == null ||
        Math.abs(tmdbExternal.media.movie.releaseYear - importedYear) > 1)
    ) {
      return null;
    }
    return {
      mediaId: localMovie.id,
      confidence: 0.95,
      matchedTitle: localMovie.title,
      tvdbId: Number(rawTvdbId),
      tmdbId,
    };
  }

  private async matchByTvdbId(
    rawTvdbId: string,
    title: string,
    type: 'SHOW' | 'MOVIE',
    year: number | null = null,
    allowMovieReclassification = true,
    hint?: ShowFootprintHint | null,
  ): Promise<MediaMatch> {
    const providerKind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    // 0) Reuse a VERIFIED LOCAL TVDB mapping — no external call.
    const localMedia = await this.findLocalMediaByExternalId(
      ExternalProvider.THE_TVDB,
      providerKind,
      rawTvdbId,
    );
    if (localMedia) {
      const expected = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;
      if (localMedia.type !== expected) {
        this.logger.warn(
          `TVDB id ${rawTvdbId} ("${title}") resolves to ${localMedia.type}, expected ${type} — rejecting incompatible identity`,
        );
        return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
      }
      // A verified local identity remains the zero-network hot path unless the archive contains
      // episode history and the target has no active episode graph at all. Empty TVDB fallback
      // rows can outlive provider merges (Devils is the production regression); accepting one
      // here makes every episode reviewable before the live/dead identity can be checked.
      const activeEpisodes =
        type === 'SHOW' && hasShowFootprintHint(hint)
          ? await this.prisma.episode.count({
              where: {
                structureState: EpisodeStructureState.ACTIVE,
                season: { show: { mediaId: localMedia.id } },
              },
            })
          : 1;
      if (activeEpisodes > 0) {
        // External ids are unique, entity-kind scoped, and were verified when attached.
        // Treat populated local catalog identities as authoritative on the import hot path.
        return { mediaId: localMedia.id, confidence: 0.95, matchedTitle: localMedia.title };
      }
      const authority = await this.prisma.show.findUnique({
        where: { mediaId: localMedia.id },
        select: { structureProvider: true },
      });
      if (authority?.structureProvider === StructureProvider.TVDB) {
        // Preserve ANIME_TVDB and TVDB_ONLY_FALLBACK routing while the exact id is revalidated.
        this.providerPref.set(localMedia.id, 'tvdb');
      }
      this.logger.log(
        `Local TVDB identity ${rawTvdbId} ("${title}") has no active episodes for an episode-bearing import — revalidating before use`,
      );
    }
    if (type === 'SHOW' && allowMovieReclassification) {
      const localMovie = await this.localTvdbMovieReclassification(rawTvdbId, title, year);
      if (localMovie) {
        this.logger.log(
          `TVDB id ${rawTvdbId} ("${title}") is already linked to TMDB movie ${localMovie.tmdbId} — reclassifying the import identity`,
        );
        return {
          mediaId: null,
          confidence: 0,
          matchedTitle: null,
          dead: true,
          reclassifiedMovie: localMovie,
        };
      }
    }

    // 0a) Exact TMDB /find translation (one call, no title search). Anime shows take the
    //     TVDB-authoritative branch instead of the TMDB record. A sibling-kind result is
    //     retained only in import diagnostics; it is never attached to incompatible media.
    // TMDB's tvdb_id /find namespace resolves TVDB series/episodes, not TVDB movies.
    // Movie ids go through TVDB's verified TMDB/IMDb remote ids in step 0b.
    if (type === 'SHOW' && this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(rawTvdbId, 'tvdb_id');
        const preferred = (type === 'SHOW' ? found?.show : found?.movie) ?? null;
        const sibling = (type === 'SHOW' ? found?.movie : found?.show) ?? null;
        if (!preferred && sibling) {
          this.logger.warn(
            `TVDB id ${rawTvdbId} ("${title}") is ${type === 'SHOW' ? 'MOVIE' : 'SHOW'} per TMDB /find, expected ${type} — rejecting incompatible identity`,
          );
          return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
        }
        if (preferred) {
          const hit = preferred;
          const kind = type;
          let routingProfile: Awaited<ReturnType<TmdbProvider['getShowRoutingProfile']>> | null =
            null;
          if (kind === 'SHOW') {
            try {
              routingProfile = await this.tmdb.getShowRoutingProfile(hit.tmdbId);
            } catch (e) {
              this.logger.debug(
                `TMDB routing profile ${hit.tmdbId} unavailable; keeping TMDB identity match: ${(e as Error).message}`,
              );
            }
          }
          if (
            kind === 'SHOW' &&
            routingProfile &&
            isAnimeSignal(routingProfile.genreIds, routingProfile.keywords)
          ) {
            const pendingAnime = async () => {
              const mediaId = await this.meta.lightUpsertShow({
                tmdbId: hit.tmdbId,
                title,
                year,
              });
              this.providerPref.set(mediaId, 'tvdb');
              if (routingProfile!.tvdbId) {
                await this.attachExternalId(
                  mediaId,
                  ExternalProvider.THE_TVDB,
                  ProviderEntityKind.SERIES,
                  String(routingProfile!.tvdbId),
                );
              }
              return { mediaId, confidence: 0.9, matchedTitle: title };
            };
            // The import's raw TVDB id is not enough to own anime structure. TMDB must
            // verify the canonical TVDB series cross-id; otherwise retain an identity-only
            // pending stub and let review/retry resolve episodes later.
            if (!routingProfile.tvdbId || !this.tvdb.enabled) return pendingAnime();
            try {
              const canonicalTvdbId = routingProfile.tvdbId;
              const s = await this.tvdb.getShow(canonicalTvdbId);
              const mediaId = await this.meta.lightUpsertShowTvdb({
                tvdbId: canonicalTvdbId,
                title: s.title,
                overview: s.overview ?? null,
                posterUrl: s.posterUrl ?? null,
                backdropUrl: s.backdropUrl ?? null,
                popularity: s.popularity ?? 0,
                year: s.yearStart ?? null,
                genres: s.genres,
              });
              this.providerPref.set(mediaId, 'tvdb');
              await this.attachExternalId(
                mediaId,
                ExternalProvider.TMDB,
                ProviderEntityKind.SERIES,
                String(hit.tmdbId),
              );
              return { mediaId, confidence: 0.9, matchedTitle: s.title };
            } catch (e) {
              this.logger.warn(
                `Anime TVDB-authoritative hydration failed for ${rawTvdbId} ("${title}") — retaining an identity-only pending stub: ${(e as Error).message}`,
              );
              return pendingAnime();
            }
          }
          const mediaId =
            kind === 'SHOW'
              ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year })
              : await this.meta.lightUpsertMovie({ tmdbId: hit.tmdbId, title, year });
          await this.attachExternalId(mediaId, ExternalProvider.THE_TVDB, providerKind, rawTvdbId);
          return { mediaId, confidence: 0.95, matchedTitle: title };
        }
      } catch (e) {
        this.logger.debug(
          `TMDB /find for TVDB id ${rawTvdbId} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }

    // 0b) TMDB didn't resolve the TVDB ID → fetch from TVDB directly. A 404 on the expected
    //     entity kind triggers one sibling-kind probe to distinguish an incompatible live
    //     id from a dead id. The sibling result is never persisted or attached.
    let dead = false;
    if (this.tvdb.enabled) {
      const numId = Number(rawTvdbId);
      const upsertShow = async () => {
        const s = await this.tvdb.getShow(numId);
        const mediaId = await this.meta.lightUpsertShowTvdb({
          tvdbId: numId,
          title: s.title,
          overview: s.overview ?? null,
          posterUrl: s.posterUrl ?? null,
          backdropUrl: s.backdropUrl ?? null,
          popularity: s.popularity ?? 0,
          year: s.yearStart ?? null,
          genres: s.genres,
        });
        return { mediaId, title: s.title };
      };
      const upsertMovie = async () => {
        const mv = await this.tvdb.getMovie(numId);
        const tmdbValue = mv.externals.find((e) => e.provider === ExternalProvider.TMDB)?.value;
        const imdbId = mv.externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
        const parsedTmdb = tmdbValue ? Number(tmdbValue) : NaN;
        const mediaId = await this.meta.lightUpsertMovieTvdb({
          tvdbId: numId,
          tmdbId: Number.isSafeInteger(parsedTmdb) && parsedTmdb > 0 ? parsedTmdb : null,
          imdbId: imdbId ?? null,
          title: mv.title,
          overview: mv.overview ?? null,
          posterUrl: mv.posterUrl ?? null,
          backdropUrl: mv.backdropUrl ?? null,
          popularity: mv.popularity ?? 0,
          year: mv.releaseYear ?? null,
        });
        return { mediaId, title: mv.title };
      };
      try {
        const r = type === 'SHOW' ? await upsertShow() : await upsertMovie();
        return { mediaId: r.mediaId, confidence: 0.85, matchedTitle: r.title };
      } catch (e) {
        if (isProviderError(e) && e.category === 'not_found') {
          if (type === 'SHOW' && !allowMovieReclassification) {
            // The imported footprint proves this identity contains several episodes. A 404 in
            // SERIES is enough to mark that series id dead; do not probe MOVIE or create a movie
            // row that the import is structurally forbidden from using.
            dead = true;
          } else {
            try {
              if (type === 'SHOW') {
                const movie = await this.tvdb.getMovie(numId);
                const reclassifiedMovie = await this.validateTvdbMovieReclassification(
                  numId,
                  title,
                  year,
                  movie,
                );
                if (reclassifiedMovie) {
                  this.logger.log(
                    `TVDB id ${rawTvdbId} ("${title}") is a validated movie with TMDB id ${reclassifiedMovie.tmdbId} — reclassifying the import identity`,
                  );
                  return {
                    mediaId: null,
                    confidence: 0,
                    matchedTitle: null,
                    dead: true,
                    reclassifiedMovie,
                  };
                }
              } else {
                await this.tvdb.getShow(numId);
              }
              // Numeric SERIES/MOVIE namespace reuse is expected provider data, not an import
              // failure by itself. Keep it at debug; the caller may still recover by the correct
              // title/alias and the final UNMATCHED counter records any real unresolved outcome.
              this.logger.debug(
                type === 'SHOW'
                  ? `TVDB series id ${rawTvdbId} ("${title}") is stale; the same number belongs to a different movie identity — ignoring the namespace collision`
                  : `TVDB movie id ${rawTvdbId} ("${title}") is stale; the same number belongs to a different series identity — ignoring the namespace collision`,
              );
              return { mediaId: null, confidence: 0, matchedTitle: null, dead: true };
            } catch (e2) {
              // A 404 on BOTH kinds means the id is DEAD — it carries no identity signal,
              // so a title fallback is legitimate. Any other failure (throttle, timeout,
              // upstream) is inconclusive: keep refusing, we can't tell if it's live.
              dead = isProviderError(e2) && e2.category === 'not_found';
              if (!dead) {
                this.logger.warn(
                  `TVDB exact-id recovery failed for ${rawTvdbId}: ${(e2 as Error).message}`,
                );
              }
            }
          }
        } else {
          this.logger.warn(
            `TVDB exact-id recovery failed for ${rawTvdbId}: ${(e as Error).message}`,
          );
        }
      }
    }

    // 0c) The caller may use exact title recovery only for a PROVABLY dead id. Keep that
    // expected state out of WARN logs: it is not the final item outcome. Inconclusive provider
    // failures remain warnings because those genuinely refuse title fallback.
    if (dead) {
      this.logger.debug(
        `TVDB ${type === 'SHOW' ? 'series' : 'movie'} ID ${rawTvdbId} for "${title}" is confirmed stale`,
      );
    } else {
      this.logger.warn(
        `TVDB ${type === 'SHOW' ? 'series' : 'movie'} ID ${rawTvdbId} for "${title}" could not be resolved via TMDB or TVDB — refusing title fallback`,
      );
    }
    return { mediaId: null, confidence: 0, matchedTitle: null, dead };
  }

  /**
   * Multi-id authority gate: TV Time rows for one show can carry several TVDB series ids
   * (TVDB merges leave dead ids in old exports — one id may be gone while a sibling works).
   * Each id is tried through the full gate in order; the first hit wins. Title fallback is
   * refused only when EVERY id fails — an id set that cannot resolve at all returns null.
   */
  private async matchByTvdbIds(
    ids: string[],
    title: string,
    type: 'SHOW' | 'MOVIE',
    year: number | null,
    allowMovieReclassification: boolean,
    hint?: ShowFootprintHint | null,
  ): Promise<MediaMatch & { allDead?: boolean }> {
    let sawInconclusive = false;
    let reclassifiedMovie: MovieReclassificationMatch | null = null;
    let conflictingMovieReclassification = false;
    for (const id of ids) {
      const r = await this.matchByTvdbId(id, title, type, year, allowMovieReclassification, hint);
      if (r.mediaId) return r;
      if (r.reclassifiedMovie) {
        if (reclassifiedMovie && reclassifiedMovie.mediaId !== r.reclassifiedMovie.mediaId) {
          conflictingMovieReclassification = true;
        } else {
          reclassifiedMovie = r.reclassifiedMovie;
        }
      }
      if (!r.dead) sawInconclusive = true;
    }
    if (ids.length > 1 && (sawInconclusive || conflictingMovieReclassification)) {
      this.logger.warn(
        `None of the ${ids.length} TVDB ids for "${title}" resolved conclusively (${ids.join(', ')}) — refusing title fallback`,
      );
    }
    // Every id is provably dead or incompatible with the imported type → it cannot identify
    // a valid target. A validated title/year search is the only remaining compatible signal.
    // Any inconclusive failure keeps the refusal (we can't tell whether the id is live).
    if (reclassifiedMovie && !sawInconclusive && !conflictingMovieReclassification) {
      return {
        mediaId: null,
        confidence: 0,
        matchedTitle: null,
        allDead: true,
        reclassifiedMovie,
      };
    }
    return {
      mediaId: null,
      confidence: 0,
      matchedTitle: null,
      allDead: !sawInconclusive && !conflictingMovieReclassification,
    };
  }

  /**
   * Show-level recovery via a TVDB EPISODE id (last resort): TV Time episode rows often carry
   * no series id, and translated titles (e.g. "The Mantis" → "La Mante") defeat title search.
   * Chain: local episode external ids (free) → TMDB /find (returns the parent show id) →
   * TVDB episode → parent series id → the TVDB authority gate (covers TVDB-only shows whose
   * export series id is dead/merged and TMDB has no mapping, e.g. some J-drama).
   * Only runs when normal show matching already failed (bounded call volume).
   */
  async recoverShowByEpisodeId(
    title: string,
    year: number | null,
    rawTvdbEpisodeId: string | number | null | undefined,
  ): Promise<MediaMatch> {
    const raw = normalizeNumericExternalId(rawTvdbEpisodeId) ?? '';
    if (!raw) return { mediaId: null, confidence: 0, matchedTitle: null };
    // 1) Local mapping: the episode is already hydrated somewhere — free, no provider call.
    const local = await this.prisma.episodeExternalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        value: raw,
        episode: { structureState: 'ACTIVE' },
      },
      include: {
        episode: { include: { season: { include: { show: { include: { media: true } } } } } },
      },
    });
    const localMedia = (local as any)?.episode?.season?.show?.media;
    if (localMedia) {
      return { mediaId: localMedia.id, confidence: 0.95, matchedTitle: localMedia.title };
    }
    // 2) TMDB /find on the episode id returns the parent TMDB show id.
    if (this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
        const showId = found?.episode?.showId;
        if (showId) {
          const mediaId = await this.meta.lightUpsertShow({ tmdbId: showId, title, year });
          return { mediaId, confidence: 0.9, matchedTitle: title };
        }
      } catch (e) {
        this.logger.debug(
          `Show recovery via episode id ${raw} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }
    // 3) TVDB episode → parent series id → full authority gate (TVDB-only shows).
    if (this.tvdb.enabled) {
      try {
        const ep = await this.tvdb.getEpisode(Number(raw));
        if (ep.seriesId) {
          const r = await this.matchByTvdbIds(
            [String(ep.seriesId)],
            title || `TVDB ${ep.seriesId}`,
            'SHOW',
            year ?? null,
            false,
          );
          if (r.mediaId) return r;
        }
      } catch (e) {
        this.logger.debug(
          `Show recovery via TVDB episode ${raw} ("${title}") failed: ${(e as Error).message}`,
        );
      }
    }
    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * The locally hydrated structure of a show: highest non-special season and, per season,
   * the highest stored episode number. Used by the structural guard to detect shows whose
   * stored structure cannot contain the import's footprint (wrong provider structure or a
   * poisoned partial hydration from a rate-limited fetch).
   */
  async hydratedFootprint(
    mediaId: string,
  ): Promise<{ maxSeason: number; maxEpisodeBySeason: Map<number, number> }> {
    const seasons = await this.prisma.season.findMany({
      where: { show: { mediaId }, episodes: { some: { structureState: 'ACTIVE' } } },
      select: {
        number: true,
        episodes: {
          where: { structureState: 'ACTIVE' },
          select: { number: true },
          orderBy: { number: 'desc' },
          take: 1,
        },
      },
    });
    const maxEpisodeBySeason = new Map<number, number>();
    let maxSeason = 0;
    for (const s of seasons) {
      if (s.number > maxSeason) maxSeason = s.number;
      maxEpisodeBySeason.set(s.number, s.episodes[0]?.number ?? 0);
    }
    return { maxSeason, maxEpisodeBySeason };
  }

  /**
   * External-ID-first matching for id-carrying exports. Order: TMDB id (local mapping, else
   * light fetch + upsert) → IMDB id (local mapping, else exact TMDB /find) → TVDB id
   * (authority gate above) → title fallback. IMDB precedes TVDB because some TV Time movie
   * rows contain a valid movie IMDB id alongside an unrelated TVDB SERIES id; the entity-kind
   * scoped IMDB lookup is the safe discriminator in that conflict.
   */
  async matchByExternalIds(
    ids: TraktIds,
    type: 'SHOW' | 'MOVIE',
    title: string,
    norm: string,
    year?: number | null,
    archiveLanguage?: SupportedLocale | null,
    hint?: ShowFootprintHint | null,
  ): Promise<MediaMatch> {
    const tvdbId = normalizeNumericExternalId(ids.tvdb);
    const hintKey = hasShowFootprintHint(hint)
      ? JSON.stringify([
          hint.maxSeason ?? null,
          [...(hint.seasonEpisodes ?? [])].sort((a, b) => a.season - b.season),
        ])
      : '';
    const key = `ext:${type}:${ids.tmdb ?? ''}:${tvdbId ?? ''}:${ids.imdb ?? ''}:${norm}:${hintKey}`;
    const done = async (result: MediaMatch): Promise<MediaMatch> => {
      const r =
        type === 'SHOW' && result.mediaId && this.canonical
          ? { ...result, mediaId: await this.canonical.resolveMediaId(result.mediaId) }
          : result;
      this.mediaCache.set(key, {
        mediaId: r.mediaId,
        confidence: r.confidence,
        title: r.matchedTitle,
        dead: r.dead,
        reclassifiedMovie: r.reclassifiedMovie,
      });
      return r;
    };
    const cached = this.mediaCache.get(key);
    if (cached)
      return done({
        mediaId: cached.mediaId,
        confidence: cached.confidence,
        matchedTitle: cached.title,
        ...(cached.dead ? { dead: true } : {}),
        ...(cached.reclassifiedMovie ? { reclassifiedMovie: cached.reclassifiedMovie } : {}),
      });
    const kind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;

    // 1) TMDB id — preferred provider. Local mapping first; on a miss validate the
    //    provider entity through the lightweight routing endpoint before attaching it.
    if (ids.tmdb) {
      const localMedia = await this.findLocalMediaByExternalId(
        ExternalProvider.TMDB,
        kind,
        String(ids.tmdb),
      );
      if (localMedia && localMedia.type === type) {
        return done({ mediaId: localMedia.id, confidence: 0.95, matchedTitle: localMedia.title });
      }
      if (localMedia) {
        this.logger.warn(
          `TMDB id ${ids.tmdb} is attached to ${localMedia.type}, expected ${type} — rejecting incompatible identity`,
        );
      }
      if (this.tmdb.enabled) {
        try {
          if (type === 'SHOW') {
            const profile = await this.tmdb.getShowRoutingProfile(ids.tmdb);
            const mediaId = await this.meta.lightUpsertShow({
              tmdbId: profile.tmdbId,
              title: profile.title,
              year: profile.yearStart,
            });
            if (profile.imdbId) {
              await this.attachExternalId(
                mediaId,
                ExternalProvider.IMDB,
                ProviderEntityKind.SERIES,
                profile.imdbId,
              );
            }
            if (profile.tvdbId) {
              await this.attachExternalId(
                mediaId,
                ExternalProvider.THE_TVDB,
                ProviderEntityKind.SERIES,
                String(profile.tvdbId),
              );
            }
            return done({ mediaId, confidence: 0.95, matchedTitle: profile.title });
          }
          const profile = await this.tmdb.getMovieRoutingProfile(ids.tmdb);
          const mediaId = await this.meta.lightUpsertMovie({
            tmdbId: profile.tmdbId,
            title: profile.title,
            year: profile.releaseYear,
          });
          if (profile.imdbId) {
            await this.attachExternalId(
              mediaId,
              ExternalProvider.IMDB,
              ProviderEntityKind.MOVIE,
              profile.imdbId,
            );
          }
          return done({ mediaId, confidence: 0.95, matchedTitle: profile.title });
        } catch (e) {
          this.logger.debug(
            `TMDB id ${ids.tmdb} upsert failed for "${title}" — falling through: ${(e as Error).message}`,
          );
        }
      }
    }

    // 2) IMDB id — local mapping first, then an exact, entity-kind-scoped /find recovery.
    if (ids.imdb) {
      const localMedia = await this.findLocalMediaByExternalId(
        ExternalProvider.IMDB,
        kind,
        ids.imdb,
      );
      const compatibleLocal = localMedia?.type === type ? localMedia : null;
      if (compatibleLocal) {
        return done({
          mediaId: compatibleLocal.id,
          confidence: 0.9,
          matchedTitle: compatibleLocal.title,
        });
      }
      if (localMedia && !compatibleLocal) {
        this.logger.warn(
          `IMDB id ${ids.imdb} is attached to ${localMedia.type}, expected ${type} — rejecting incompatible identity`,
        );
      }
      if (this.tmdb.enabled) {
        try {
          const found = await this.tmdb.findByExternalId(ids.imdb, 'imdb_id');
          const hit = type === 'SHOW' ? found?.show : found?.movie;
          const sibling = type === 'SHOW' ? found?.movie : found?.show;
          if (hit) {
            const mediaId =
              type === 'SHOW'
                ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year: year ?? null })
                : await this.meta.lightUpsertMovie({
                    tmdbId: hit.tmdbId,
                    title,
                    year: year ?? null,
                  });
            await this.attachExternalId(mediaId, ExternalProvider.IMDB, kind, ids.imdb);
            return done({ mediaId, confidence: 0.9, matchedTitle: title });
          }
          if (sibling) {
            this.logger.warn(
              `IMDB id ${ids.imdb} resolves to ${type === 'SHOW' ? 'MOVIE' : 'SHOW'}, expected ${type} — rejecting stale local identity`,
            );
          }
        } catch (e) {
          this.logger.debug(
            `IMDB /find for ${ids.imdb} ("${title}") failed: ${(e as Error).message}`,
          );
        }
      }
    }

    // 3) TVDB id — authority gate (no title fallback inside). This intentionally runs after
    //    IMDB so a malformed movie row's TVDB SERIES id cannot preempt its valid IMDB id.
    if (tvdbId) {
      const r = await this.matchMedia(norm, title, type, year, hint, archiveLanguage, tvdbId, [
        tvdbId,
      ]);
      return done(r);
    }

    // 4) No id resolved → regular title matching.
    const r = await this.matchMedia(norm, title, type, year, hint, archiveLanguage);
    return done(r);
  }

  /**
   * Episode fast path for id-carrying imports (Trakt episode ids, TV Time rawTvdbEpisodeId):
   * resolve an episode of an already-matched show by its external episode id (TMDB first, then
   * TVDB) via EpisodeExternalId. Scoped to the matched mediaId so an id belonging to a
   * different show never leaks in. Returns null on a miss — the caller silently falls back to
   * season/episode resolution.
   */
  async resolveEpisodeByExternalIds(mediaId: string, ids: TraktIds): Promise<string | null> {
    const requestedMediaId = mediaId;
    mediaId = this.canonical ? await this.canonical.resolveMediaId(mediaId) : mediaId;
    const candidates: { provider: ExternalProvider; value: string }[] = [];
    if (ids.tmdb) candidates.push({ provider: ExternalProvider.TMDB, value: String(ids.tmdb) });
    const tvdbId = normalizeNumericExternalId(ids.tvdb);
    if (tvdbId) candidates.push({ provider: ExternalProvider.THE_TVDB, value: tvdbId });
    for (const c of candidates) {
      const cacheKey = `ext-ep:${mediaId}:${c.provider}:${c.value}`;
      if (this.episodeCache.has(cacheKey)) return this.episodeCache.get(cacheKey)!;
      const ext = await this.prisma.episodeExternalId.findFirst({
        where: {
          provider: c.provider,
          providerEntityKind: ProviderEntityKind.EPISODE,
          value: c.value,
          episode: {
            structureState: 'ACTIVE',
            season: { show: { mediaId: { in: [...new Set([requestedMediaId, mediaId])] } } },
          },
        },
        select: { episodeId: true },
      });
      if (ext?.episodeId) {
        const episodeId = this.canonical
          ? await this.canonical.resolveEpisodeId(ext.episodeId)
          : ext.episodeId;
        this.setEpisodeCache(cacheKey, episodeId);
        return episodeId;
      }
    }
    return null;
  }

  /**
   * Route one authoritative TVDB episode id to its actual local TMDB show and episode. TVDB can
   * model an anthology as one multi-season series while TMDB models every season as a separate
   * one-season show (The Haunting and Monster are real examples). The episode-level `/find`
   * result is therefore stronger than the source series-level match.
   */
  async recoverEpisodeTargetByTvdbId(
    title: string,
    year: number | null,
    rawTvdbEpisodeId: string | number | null | undefined,
  ): Promise<{ mediaId: string; episodeId: string } | null> {
    const raw = normalizeNumericExternalId(rawTvdbEpisodeId) ?? '';
    if (!raw) return null;

    const local = await this.prisma.episodeExternalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.EPISODE,
        value: raw,
        episode: { structureState: 'ACTIVE' },
      },
      select: {
        episodeId: true,
        episode: { select: { season: { select: { show: { select: { mediaId: true } } } } } },
      },
    });
    const localMediaId = local?.episode?.season?.show?.mediaId;
    if (local?.episodeId && localMediaId) {
      return {
        mediaId: this.canonical ? await this.canonical.resolveMediaId(localMediaId) : localMediaId,
        episodeId: this.canonical
          ? await this.canonical.resolveEpisodeId(local.episodeId)
          : local.episodeId,
      };
    }
    if (!this.tmdb.enabled) return null;

    try {
      const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
      const episode = found?.episode;
      if (!episode?.showId) return null;
      const mediaId = await this.meta.lightUpsertShow({
        tmdbId: episode.showId,
        title,
        year,
      });
      await this.ensureShowHydrated(mediaId);
      const episodeId =
        (await this.resolveEpisodeByExternalIds(mediaId, {
          tmdb: episode.tmdbEpisodeId,
        })) ?? (await this.resolveEpisode(mediaId, episode.season, episode.episode));
      if (!episodeId) return null;
      await this.attachEpisodeExternalId(
        episodeId,
        ExternalProvider.TMDB,
        String(episode.tmdbEpisodeId),
      );
      await this.attachEpisodeExternalId(episodeId, ExternalProvider.THE_TVDB, raw);
      return { mediaId, episodeId };
    } catch (error) {
      this.logger.debug(
        `Episode target recovery via TVDB id ${raw} ("${title}") failed: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Episode /find recovery for TV Time rows: translate the TVDB episode id via TMDB /find —
   * the response carries TMDB's OWN season/episode numbers (and the parent show), so the
   * final S/E lookup is consistent with the TMDB-hydrated structure even when TVDB numbering
   * differs. Runs ONLY when local resolution (external id + S/E) already failed, so call
   * volume stays bounded to problem episodes. The found TMDB episode id is attached to the
   * resolved episode (best-effort) so later imports hit the local fast path.
   */
  async recoverEpisodeByTvdbId(
    mediaId: string,
    rawTvdbEpisodeId: string | number | null | undefined,
    skipTmdbFind = false,
  ): Promise<string | null> {
    const raw = normalizeNumericExternalId(rawTvdbEpisodeId) ?? '';
    if (!raw) return null;

    const [tmdbExt, tvdbExt] = await Promise.all([
      this.prisma.externalId.findFirst({
        where: {
          mediaId,
          provider: ExternalProvider.TMDB,
          providerEntityKind: ProviderEntityKind.SERIES,
        },
      }),
      this.prisma.externalId.findFirst({
        where: {
          mediaId,
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: ProviderEntityKind.SERIES,
        },
      }),
    ]);

    // Preferred path: TMDB /find translates the TVDB episode id into TMDB's own structure.
    if (this.tmdb.enabled && !skipTmdbFind) {
      try {
        const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
        const ep = found?.episode;
        if (ep && (!tmdbExt || String(ep.showId) === tmdbExt.value)) {
          const episodeId = await this.resolveEpisode(mediaId, ep.season, ep.episode);
          if (episodeId) {
            await this.attachEpisodeExternalId(
              episodeId,
              ExternalProvider.TMDB,
              String(ep.tmdbEpisodeId),
            );
            await this.attachEpisodeExternalId(episodeId, ExternalProvider.THE_TVDB, raw);
            return episodeId;
          }
        }
      } catch (e) {
        this.logger.debug(`Episode recovery via TMDB /find ${raw} failed: ${(e as Error).message}`);
      }
    }

    // The complete show-level TVDB routing snapshot already evaluated this identity. A verified
    // but unmapped alias is intentionally reviewable; retrying /episodes/{id} cannot add stronger
    // evidence and would turn a large import into one provider call per row. Likewise, suppress
    // the per-row fallback briefly after a failed batch snapshot.
    if (
      this.verifiedCanonicalEpisodeAliases.has(this.canonicalEpisodeAliasKey(mediaId, raw)) ||
      (this.tvdbBatchUnavailableUntil.get(mediaId) ?? 0) > Date.now()
    ) {
      return null;
    }

    // TVDB fallback: the imported episode must prove it belongs to the matched media's exact
    // TVDB series. A regular provider coordinate can safely reuse the same S/E path the import
    // already uses; specials remain exact-alias-only. Hydrate only when neither path exists.
    if (this.tvdb.enabled && tvdbExt) {
      try {
        const resolved = await this.tvdb.getEpisode(Number(raw));
        if (!resolved.seriesId || String(resolved.seriesId) !== tvdbExt.value) return null;
        const canUseCoordinate =
          resolved.seasonNumber != null && resolved.seasonNumber > 0 && resolved.episode.number > 0;
        let episodeId =
          (await this.resolveEpisodeByExternalIds(mediaId, { tvdb: Number(raw) })) ??
          (canUseCoordinate
            ? await this.resolveEpisode(mediaId, resolved.seasonNumber!, resolved.episode.number)
            : null) ??
          (await this.resolveEpisodeByProviderMetadata(
            mediaId,
            resolved.episode.title,
            resolved.episode.airDate,
          ));
        if (!episodeId) {
          // A show with no structure may have been light-upserted recently and therefore look
          // metadata-fresh. Hydrate that show once; never force-refresh an already populated
          // catalog once per unresolved episode id.
          await this.ensureShowHydrated(mediaId);
          episodeId =
            (await this.resolveEpisodeByExternalIds(mediaId, { tvdb: Number(raw) })) ??
            (canUseCoordinate
              ? await this.resolveEpisode(mediaId, resolved.seasonNumber!, resolved.episode.number)
              : null) ??
            (await this.resolveEpisodeByProviderMetadata(
              mediaId,
              resolved.episode.title,
              resolved.episode.airDate,
            ));
        }
        if (episodeId) {
          await this.attachEpisodeExternalId(episodeId, ExternalProvider.THE_TVDB, raw);
          return episodeId;
        }
      } catch (e) {
        this.logger.debug(`Episode recovery via TVDB ${raw} failed: ${(e as Error).message}`);
      }
    }
    return null;
  }

  private async resolveEpisodeByProviderMetadata(
    mediaId: string,
    title: string | null | undefined,
    airDate: string | null | undefined,
  ): Promise<string | null> {
    const normalizedTitle = normTitle(title ?? '');
    if (airDate) {
      const day = /^\d{4}-\d{2}-\d{2}/.exec(airDate)?.[0];
      if (day) {
        const start = new Date(`${day}T00:00:00.000Z`);
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
        const candidates = await this.prisma.episode.findMany({
          where: {
            structureState: 'ACTIVE',
            season: { show: { mediaId } },
            airDate: { gte: start, lt: end },
          },
          select: { id: true, title: true },
          take: 10,
        });
        const exactTitle = normalizedTitle
          ? candidates.filter((candidate) => normTitle(candidate.title) === normalizedTitle)
          : [];
        if (exactTitle.length === 1) return exactTitle[0].id;
        if (candidates.length === 1) return candidates[0].id;
      }
    }
    if (title?.trim()) {
      const candidates = await this.prisma.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId } },
          title: { equals: title.trim(), mode: 'insensitive' },
        },
        select: { id: true },
        take: 2,
      });
      if (candidates.length === 1) return candidates[0].id;
    }
    return null;
  }

  /** Attach an id already verified by its provider; repair a stale alias owner if needed. */
  private async attachExternalId(
    mediaId: string,
    provider: ExternalProvider,
    kind: ProviderEntityKind,
    value: string,
  ) {
    // A bulk prefetch may have cached this identity as absent before provider recovery.
    this.externalMediaCache.delete(this.externalMediaKey(provider, kind, value));
    const existing = await this.prisma.externalId.findFirst({
      where: { provider, providerEntityKind: kind, value },
      select: { id: true, mediaId: true },
    });
    if (existing) {
      const anchoredOwner =
        existing.mediaId !== mediaId && provider !== ExternalProvider.TMDB
          ? await this.prisma.externalId.findFirst({
              where: {
                mediaId: existing.mediaId,
                provider: ExternalProvider.TMDB,
                providerEntityKind: kind,
              },
              select: { value: true },
            })
          : null;
      if (existing.mediaId !== mediaId && anchoredOwner) {
        await this.prisma.externalId.update({
          where: { id: existing.id },
          data: { mediaId },
        });
        this.logger.warn(
          `Repointed verified ${provider}/${kind} id ${value} from ${existing.mediaId} to ${mediaId}`,
        );
      } else if (existing.mediaId !== mediaId) {
        this.logger.warn(
          `Verified ${provider}/${kind} id ${value} is held by unanchored row ${existing.mediaId}; preserving it for the audited duplicate/remap repair`,
        );
      }
      return;
    }
    try {
      await this.prisma.externalId.create({
        data: { mediaId, provider, providerEntityKind: kind, value },
      });
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      const raced = await this.prisma.externalId.findFirst({
        where: { provider, providerEntityKind: kind, value },
        select: { id: true, mediaId: true },
      });
      const anchoredOwner =
        raced && raced.mediaId !== mediaId && provider !== ExternalProvider.TMDB
          ? await this.prisma.externalId.findFirst({
              where: {
                mediaId: raced.mediaId,
                provider: ExternalProvider.TMDB,
                providerEntityKind: kind,
              },
              select: { value: true },
            })
          : null;
      if (raced && raced.mediaId !== mediaId && anchoredOwner) {
        await this.prisma.externalId.update({
          where: { id: raced.id },
          data: { mediaId },
        });
      }
    }
  }

  /** Best-effort attach of an external id to an episode (repoints on unique conflict). */
  private async attachEpisodeExternalId(
    episodeId: string,
    provider: ExternalProvider,
    value: string,
  ) {
    try {
      await this.prisma.episodeExternalId.upsert({
        where: {
          provider_providerEntityKind_value: {
            provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value,
          },
        },
        create: { episodeId, provider, providerEntityKind: ProviderEntityKind.EPISODE, value },
        update: { episodeId },
      });
    } catch {
      // best-effort only
    }
  }

  /**
   * Among several exact-title show candidates, pick the one that best fits the import's
   * season/episode footprint. Fetches details for up to 5 candidates (only on genuine title
   * ambiguity). A candidate is "qualified" if it has at least the import's highest season AND
   * every referenced season has at least as many episodes as the import's highest episode there
   * (e.g. import watched S1 up to E10 → a candidate whose S1 has only 5 episodes is out).
   * Among qualified candidates, the closest fit wins (fewest extra seasons). Returns null when
   * none can contain the imported structure; callers must not retain a title-only default.
   */
  private async disambiguateShow<T extends { tmdbId: number; title: string }>(
    candidates: T[],
    hint: {
      maxSeason?: number | null;
      seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
    },
  ): Promise<T | null> {
    const maxSeason = hint.maxSeason ?? 0;
    const epBySeason = new Map<number, number>();
    for (const se of hint.seasonEpisodes ?? []) {
      epBySeason.set(se.season, Math.max(epBySeason.get(se.season) ?? 0, se.maxEpisode));
    }

    const scored = await Promise.all(
      candidates.slice(0, 5).map(async (c) => {
        try {
          const s = await this.tmdb.getShow(c.tmdbId);
          const seasonEpCounts = new Map<number, number>();
          for (const se of s.seasons ?? []) {
            if (se.isSpecial || se.number === 0) continue; // ignore specials
            seasonEpCounts.set(se.number, se.episodeCount);
          }
          const totalSeasons = s.seasonsCount ?? 0;

          let qualified = totalSeasons >= maxSeason;
          for (const [season, maxEp] of epBySeason) {
            const cand = seasonEpCounts.get(season) ?? 0;
            if (cand < maxEp) {
              qualified = false;
            }
          }
          const extraSeasons = Math.max(0, totalSeasons - maxSeason);
          return { item: c, qualified, extraSeasons };
        } catch {
          return null;
        }
      }),
    );

    type Score = {
      item: T;
      qualified: boolean;
      extraSeasons: number;
    };
    const valid = scored.filter(Boolean) as Score[];

    const qualified = valid
      .filter((d) => d.qualified)
      .sort((a, b) => a.extraSeasons - b.extraSeasons);
    if (qualified.length) return qualified[0].item;
    return null;
  }

  private async disambiguateTvdbShow<T extends { tvdbId?: number | null; title: string }>(
    candidates: T[],
    hint: ShowFootprintHint,
    requireExactFootprint = false,
  ): Promise<T | null> {
    const maxSeason = hint.maxSeason ?? 0;
    const requiredEpisodes = new Map(
      (hint.seasonEpisodes ?? []).map(({ season, maxEpisode }) => [season, maxEpisode]),
    );
    const qualified = (
      await Promise.all(
        candidates.slice(0, 5).map(async (candidate) => {
          if (!candidate.tvdbId) return null;
          try {
            const show = await this.tvdb.getShow(candidate.tvdbId);
            if (requireExactFootprint) {
              return this.tvdbShowFitsImportFootprint(show, hint, false)
                ? { candidate, extraSeasons: 0 }
                : null;
            }
            if ((show.seasonsCount ?? 0) < maxSeason) return null;
            const episodeCounts = new Map(
              (show.seasons ?? [])
                .filter((season) => !season.isSpecial && season.number > 0)
                .map((season) => [season.number, season.episodeCount]),
            );
            const fits = [...requiredEpisodes].every(
              ([season, maxEpisode]) => (episodeCounts.get(season) ?? 0) >= maxEpisode,
            );
            return fits
              ? { candidate, extraSeasons: Math.max(0, show.seasonsCount - maxSeason) }
              : null;
          } catch {
            return null;
          }
        }),
      )
    ).filter(Boolean) as Array<{ candidate: T; extraSeasons: number }>;
    return qualified.sort((a, b) => a.extraSeasons - b.extraSeasons)[0]?.candidate ?? null;
  }

  /** Ensure a show has seasons/episodes in DB (needed to resolve episode by S/E). Skips if already hydrated. */
  async ensureShowHydrated(mediaId: string): Promise<void> {
    const inFlight = this.showHydrationInFlight.get(mediaId);
    if (inFlight) return inFlight;
    const hydration = this.ensureShowHydratedUncached(mediaId).finally(() => {
      if (this.showHydrationInFlight.get(mediaId) === hydration) {
        this.showHydrationInFlight.delete(mediaId);
      }
    });
    this.showHydrationInFlight.set(mediaId, hydration);
    return hydration;
  }

  private async ensureShowHydratedUncached(mediaId: string): Promise<void> {
    // Already hydrated? Then there's nothing to fetch — this is what makes re-imports fast.
    const epCount = await this.prisma.episode.count({
      where: { structureState: 'ACTIVE', season: { show: { mediaId } } },
    });
    if (epCount > 0) return;

    const [tmdbExt, tvdbExt] = await Promise.all([
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.TMDB } }),
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.THE_TVDB } }),
    ]);

    // Anime shows matched via the TVDB-authoritative branch hydrate from TVDB first:
    // TMDB anime season/episode structures are unreliable.
    if (this.providerPref.get(mediaId) === 'tvdb' && tvdbExt && this.tvdb?.enabled) {
      try {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value), undefined, {
          forceRefresh: true,
          skipClassification: true,
        });
      } catch {
        // Confirmed anime never writes a temporary TMDB graph. A later retry/review can
        // resolve it once TVDB is available.
      }
      return;
    }

    // Try TMDB first (preferred provider).
    if (tmdbExt && this.tmdb.enabled) {
      try {
        await this.meta.ensureShowFull(Number(tmdbExt.value), undefined, {
          forceRefresh: true,
        });
        return; // Success — episodes are now available.
      } catch {
        // Fall through to TVDB.
      }
    }

    // Try TVDB (for TVDB-only shows matched via Step 5 recovery — they have no TMDB ID).
    if (tvdbExt && this.tvdb?.enabled) {
      try {
        // Best-effort: create seasons + episodes from TVDB so episode resolution works.
        // Never throws — degrades gracefully to NEEDS_REVIEW if TVDB fails.
        await this.meta
          .ensureShowFullTvdb(Number(tvdbExt.value), undefined, {
            forceRefresh: true,
            skipClassification: true,
          })
          .catch(() => undefined);
      } catch {
        // ignore — episode resolve will just fail to needs_review
      }
    }
  }

  /**
   * Resolve an episode by season+number for a matched show. With `lenient` (used only for
   * manual "apply to all" resolution), falls back to the same episode number in any non-special
   * season when the exact season isn't found — this handles anthology imports where one source
   * show's seasons are distinct real shows with their own season 1 (e.g. "The Haunting" S2 →
   * Bly Manor, whose episodes are Bly Manor S1E1…E9, not S2). The main auto-import keeps strict
   * matching so S2 episodes aren't silently mapped to the wrong show's S1.
   */
  async resolveEpisode(
    mediaId: string,
    season: number,
    episode: number,
    lenient = false,
  ): Promise<string | null> {
    mediaId = this.canonical ? await this.canonical.resolveMediaId(mediaId) : mediaId;
    const key = `${mediaId}:${season}:${episode}:${lenient ? 'l' : 's'}`;
    if (this.episodeCache.has(key)) return this.episodeCache.get(key)!;
    let matches = await this.prisma.episode.findMany({
      where: {
        structureState: 'ACTIVE',
        season: { show: { mediaId }, number: season },
        number: episode,
      },
      take: 2,
    });
    if (matches.length !== 1 && lenient && season !== 0) {
      // Fallback: same episode number in the lowest non-special season of the show.
      matches = await this.prisma.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId }, number: { not: 0 } },
          number: episode,
        },
        orderBy: { season: { number: 'asc' } },
        take: 2,
      });
    }
    const id = matches.length === 1 ? matches[0].id : null;
    // Only cache POSITIVE results — never cache null (the show may get hydrated later).
    if (id) this.setEpisodeCache(key, id);
    return id;
  }

  /**
   * A manual show selection is strong show-level identity, but it does not prove that the
   * currently active provider graph can represent every imported episode. Before applying the
   * selection, compare/repair authority once when at least one requested coordinate cannot be
   * resolved by the same exact-or-anthology rules used by {@link resolveEpisode}.
   *
   * The authority evaluator owns the all-or-nothing user-data gate. A blocked/deferred result
   * leaves the import rows in NEEDS_REVIEW; it never switches structure underneath them.
   */
  async reconcileStructureForMissingEpisodes(
    mediaId: string,
    coordinates: readonly { season: number; episode: number }[],
  ): Promise<{ attempted: boolean; repaired: boolean; blocked: boolean }> {
    mediaId = this.canonical ? await this.canonical.resolveMediaId(mediaId) : mediaId;
    const unique = [
      ...new Map(
        coordinates
          .filter(
            (coordinate) =>
              Number.isFinite(coordinate.season) && Number.isFinite(coordinate.episode),
          )
          .map((coordinate) => [`${coordinate.season}:${coordinate.episode}`, coordinate]),
      ).values(),
    ];
    if (unique.length === 0) return { attempted: false, repaired: false, blocked: false };

    const episodes = await this.prisma.episode.findMany({
      where: {
        structureState: EpisodeStructureState.ACTIVE,
        season: { show: { mediaId } },
        number: { in: [...new Set(unique.map((coordinate) => coordinate.episode))] },
      },
      select: { number: true, season: { select: { number: true } } },
    });
    const hasUnresolvedCoordinate = unique.some((coordinate) => {
      const exact = episodes.filter(
        (candidate) =>
          candidate.season.number === coordinate.season && candidate.number === coordinate.episode,
      );
      if (exact.length === 1) return false;
      if (coordinate.season === 0) return true;
      const lenient = episodes.filter(
        (candidate) => candidate.season.number !== 0 && candidate.number === coordinate.episode,
      );
      return lenient.length !== 1;
    });
    if (!hasUnresolvedCoordinate) {
      return { attempted: false, repaired: false, blocked: false };
    }

    try {
      const result = await this.meta.evaluateShowStructureAuthority(mediaId);
      const repaired = result.evaluated && !result.blocked && result.deferred !== true;
      if (repaired) {
        // Same-provider snapshot refreshes can replace episode rows even when the authority label
        // did not change. Never retain a positive cache entry across any successful evaluation.
        const prefix = `${mediaId}:`;
        for (const key of this.episodeCache.keys()) {
          if (key.startsWith(prefix)) this.episodeCache.delete(key);
        }
      }
      return { attempted: true, repaired, blocked: result.blocked };
    } catch (error) {
      this.logger.warn(
        `Structure reconciliation failed for manually selected show ${mediaId}: ${(error as Error).message}`,
      );
      return { attempted: true, repaired: false, blocked: false };
    }
  }

  classify(confidence: number): 'matched' | 'needs_review' | 'unmatched' {
    if (confidence >= 0.7) return 'matched';
    if (confidence >= 0.45) return 'needs_review';
    return 'unmatched';
  }
}

/**
 * Structural guard (pure): does the import's season/episode footprint exceed the show's
 * locally hydrated structure? True when the hydrated show cannot contain referenced
 * episodes — e.g. matched the TMDB structure of a show whose TVDB structure differs
 * (anthologies, reboot continuations, split/merged hour-longs), or a poisoned partial
 * hydration (rate-limited fetch stored 1 episode). The processor records this as a
 * diagnostic only; it never hydrates a second provider graph into the show.
 */
export function needsTvdbRehydration(
  footprint: {
    maxSeason?: number | null;
    seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
  },
  hydrated: { maxSeason: number; maxEpisodeBySeason: Map<number, number> },
): boolean {
  if (
    footprint.maxSeason != null &&
    footprint.maxSeason > 0 &&
    hydrated.maxSeason < footprint.maxSeason
  ) {
    return true;
  }
  for (const se of footprint.seasonEpisodes ?? []) {
    if (se.season === 0) continue; // specials are optional everywhere
    if ((hydrated.maxEpisodeBySeason.get(se.season) ?? 0) < se.maxEpisode) return true;
  }
  return false;
}
