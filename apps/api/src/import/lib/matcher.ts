import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider, MediaType, ProviderEntityKind, type SupportedLocale } from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runInLanguage, currentLanguage } from '../../common/language.context';
import { MediaMetadataService } from '../../media-metadata/media-metadata.service';
import { TmdbProvider } from '../../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../../media-metadata/providers/tvdb.provider';
import { normTitle } from './inference';
import { isAnimeSignal } from '../../media-metadata/classification/anime-signal';
import type { TraktIds } from './trakt/types';

/** Shared return shape of all media-matching entry points. */
type MediaMatch = { mediaId: string | null; confidence: number; matchedTitle: string | null };

export interface MatchResult {
  mediaId: string | null;
  episodeId: string | null;
  confidence: number;
  status: 'matched' | 'needs_review' | 'unmatched';
  matchedTitle: string | null;
}

@Injectable()
export class ImportMatcher {
  private readonly logger = new Logger(ImportMatcher.name);
  private readonly mediaCache = new Map<string, { mediaId: string | null; confidence: number; title: string | null }>();
  private readonly episodeCache = new Map<string, string | null>();
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
  ) {}

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
    hint?: {
      maxSeason?: number | null;
      seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
    } | null,
    archiveLanguage?: SupportedLocale | null,
    /**
     * Raw TVDB series id from a TV Time export (s_id/series_id/tv_show_id). When present,
     * this is the AUTHORITATIVE identity signal: only TVDB-ID-based resolution is used,
     * NEVER title fallback. If the ID can't be resolved (locally or via TVDB API), the
     * item goes to NEEDS_REVIEW instead of being matched to a different show by title.
     */
    rawTvdbSeriesId?: string | null,
    /**
     * ALL distinct TVDB series ids collected across duplicate rows of the same title
     * (TV Time sometimes carries two ids for one show after a TVDB merge — one dead, one
     * live). When present, each id is tried in order through the authority gate; title
     * fallback is refused only when EVERY id fails.
     */
    rawTvdbSeriesIds?: string[],
  ): Promise<{ mediaId: string | null; confidence: number; matchedTitle: string | null }> {
    const ids = rawTvdbSeriesIds?.length ? rawTvdbSeriesIds : rawTvdbSeriesId ? [rawTvdbSeriesId] : [];
    const key = `${type}:${norm}:${ids.join(',')}`;
    const cached = this.mediaCache.get(key);
    if (cached) return { mediaId: cached.mediaId, confidence: cached.confidence, matchedTitle: cached.title };

    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;

    // ═══════════════════════════════════════════════════════════════════════════════
    // TVDB ID AUTHORITY GATE: when raw TVDB series IDs are present, they MUST be respected.
    // But TMDB is preferred for data quality — so we try TMDB first (exact /find) and only
    // fall back to TVDB. Title matching to a DIFFERENT show is FORBIDDEN.
    // ═══════════════════════════════════════════════════════════════════════════════

    if (ids.length) {
      const r = await this.matchByTvdbIds(ids, title, type, year ?? null);
      this.mediaCache.set(key, { mediaId: r.mediaId, confidence: r.confidence, title: r.matchedTitle });
      return r;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TITLE-ONLY MATCHING (no external ID available)
    // ═══════════════════════════════════════════════════════════════════════════════

    // 1) DB exact normalized match
    const exact = await this.prisma.mediaItem.findFirst({
      where: { type: mediaType, title: { equals: title, mode: 'insensitive' } },
    });
    if (exact && normTitle(exact.title) === norm) {
      const confidence = 0.9;
      this.mediaCache.set(key, { mediaId: exact.id, confidence, title: exact.title });
      return { mediaId: exact.id, confidence, matchedTitle: exact.title };
    }

    // 2) DB contains match (normalized compare)
    const like = await this.prisma.mediaItem.findMany({
      where: { type: mediaType, title: { contains: title, mode: 'insensitive' } },
      take: 10,
    });
    const normLike = like.find((m) => normTitle(m.title) === norm);
    if (normLike) {
      this.mediaCache.set(key, { mediaId: normLike.id, confidence: 0.8, title: normLike.title });
      return { mediaId: normLike.id, confidence: 0.8, matchedTitle: normLike.title };
    }

    // 2b) DB exact match on the "core" title (all parentheticals stripped).
    //     Catches variants like "The Office (US)" vs "The Office" without calling TMDb.
    const core = title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    if (core && core.toLowerCase() !== title.toLowerCase()) {
      const coreMatch = await this.prisma.mediaItem.findFirst({
        where: { type: mediaType, title: { equals: core, mode: 'insensitive' } },
      });
      if (coreMatch) {
        const confidence = 0.85;
        this.mediaCache.set(key, { mediaId: coreMatch.id, confidence, title: coreMatch.title });
        return { mediaId: coreMatch.id, confidence, matchedTitle: coreMatch.title };
      }
    }

    // 2c) DB match on localized titles JSON — matches already-localized rows
    //     (English base + a non-English override) without calling TMDb.
    //     Useful for re-imports and shared catalogs.
    const jsonCandidates = await this.prisma.$queryRaw<
      Array<{ id: string; title: string; titles: any }>
    >`
      SELECT id, title, titles FROM media_items
      WHERE type::text = ${mediaType} AND titles IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(titles) kv WHERE kv.value ILIKE ${title})
      LIMIT 10
    `;
    const jsonMatch = jsonCandidates.find((c) => {
      if (!c.titles || typeof c.titles !== 'object') return false;
      return Object.values(c.titles).some((v) => normTitle(String(v)) === norm);
    });
    if (jsonMatch) {
      const confidence = 0.85;
      this.mediaCache.set(key, { mediaId: jsonMatch.id, confidence, title: jsonMatch.title });
      return { mediaId: jsonMatch.id, confidence, matchedTitle: jsonMatch.title };
    }

    // 3) TMDb search fallback
    if (this.tmdb.enabled) {
      try {
        const res = type === 'SHOW' ? await this.tmdb.searchShows(title, 1) : await this.tmdb.searchMovies(title, 1);
        const exactMatches = res.items.filter((i) => normTitle(i.title) === norm);
        let best = exactMatches[0] ?? res.items[0];
        // Disambiguate duplicate titles using the import's season/episode footprint: prefer the
        // candidate that has enough seasons AND enough episodes in each referenced season.
        const hasHint = !!hint && (!!hint.maxSeason || !!(hint.seasonEpisodes && hint.seasonEpisodes.length));
        if (type === 'SHOW' && exactMatches.length > 1 && hasHint) {
          best = (await this.disambiguateShow(exactMatches, hint!)) ?? best;
        }
        if (best) {
          const sameTitle = normTitle(best.title) === norm;
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
            type === 'SHOW' ? await this.tmdb.searchShows(title, 1) : await this.tmdb.searchMovies(title, 1);
          const exactMatches = r.items.filter((i) => normTitle(i.title) === norm);
          const b = exactMatches[0] ?? r.items[0];
          if (!b) return null;
          const mid =
            type === 'SHOW' ? await this.meta.lightUpsertShow(b) : await this.meta.lightUpsertMovie(b);
          return { mid, title: b.title, sameTitle: normTitle(b.title) === norm };
        });
        if (found) {
          const confidence = found.sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId: found.mid, confidence, title: found.title });
          return { mediaId: found.mid, confidence, matchedTitle: found.title };
        }
      } catch (e) {
        this.logger.warn(`TMDb archive-lang (${archiveLanguage}) match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // 4) TVDB fallback (backup provider) — used when TMDb has no/weak result.
    if (this.tvdb.enabled) {
      try {
        const res = type === 'SHOW' ? await this.tvdb.searchShows(title, 1) : await this.tvdb.searchMovies(title, 1);
        const best = res.items.find((i) => normTitle(i.title) === norm) ?? res.items[0];
        if (best && best.tvdbId) {
          const sameTitle = normTitle(best.title) === norm;
          const tvdbArgs = {
            tvdbId: best.tvdbId,
            title: best.title,
            overview: best.overview ?? null,
            posterUrl: best.posterUrl ?? null,
            backdropUrl: best.backdropUrl ?? null,
            popularity: best.popularity ?? 0,
            year: best.year ?? null,
          };
          const mediaId =
            type === 'SHOW' ? await this.meta.lightUpsertShowTvdb(tvdbArgs) : await this.meta.lightUpsertMovieTvdb(tvdbArgs);
          // Slightly more conservative than TMDb (it's a backup), but exact title → matched.
          const confidence = sameTitle ? 0.72 : 0.5;
          this.mediaCache.set(key, { mediaId, confidence, title: best.title });
          return { mediaId, confidence, matchedTitle: best.title };
        }
      } catch (e) {
        this.logger.warn(`TVDB match failed for "${title}": ${(e as Error).message}`);
      }
    }

    // NOTE: Old Step 5 (TVDB exact-id recovery) was moved to Step 0b above.
    // When rawTvdbSeriesId is present, the TVDB authority gate (Step 0/0b/0c) handles
    // everything BEFORE any title matching. Title matching only runs when there's NO
    // external ID at all.

    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * TVDB-authority resolution (shared by the CSV rawTvdbSeriesId gate and the Trakt
   * external-id path): local TVDB mapping → exact TMDB /find translation → direct TVDB fetch.
   * NEVER falls back to title matching — an unresolvable id returns null/confidence 0.
   * Anime shows (Animation genre + JP origin per /find) are TVDB-authoritative: TMDB anime
   * season/episode structures are unreliable, so they get a TVDB-backed record + TVDB-first
   * hydration (providerPref), with the TMDB id still attached for cross-lookups.
   * The CALLER is responsible for caching the result.
   */
  private async matchByTvdbId(rawTvdbSeriesId: string, title: string, type: 'SHOW' | 'MOVIE', year: number | null = null): Promise<MediaMatch> {
    // 0) Reuse a VERIFIED LOCAL TVDB mapping — no external call.
    const ext = await this.prisma.externalId.findFirst({
      where: {
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
        value: rawTvdbSeriesId,
      },
      include: { media: true },
    });
    if (ext?.media) {
      return { mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title };
    }

    // 0a) Exact TMDB /find translation (one call, no title search). Anime shows take the
    //     TVDB-authoritative branch instead of the TMDB record.
    if (this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(rawTvdbSeriesId, 'tvdb_id');
        const hit = type === 'SHOW' ? found?.show : found?.movie;
        if (hit) {
          if (type === 'SHOW' && this.tvdb.enabled && isAnimeSignal(found!.show!.genreIds, found!.show!.originCountries)) {
            try {
              const s = await this.tvdb.getShow(Number(rawTvdbSeriesId));
              const mediaId = await this.meta.lightUpsertShowTvdb({
                tvdbId: Number(rawTvdbSeriesId),
                title: s.title,
                overview: s.overview ?? null,
                posterUrl: s.posterUrl ?? null,
                backdropUrl: s.backdropUrl ?? null,
                popularity: s.popularity ?? 0,
                year: s.yearStart ?? null,
              });
              this.providerPref.set(mediaId, 'tvdb');
              await this.attachExternalId(mediaId, ExternalProvider.TMDB, ProviderEntityKind.SERIES, String(hit.tmdbId));
              return { mediaId, confidence: 0.9, matchedTitle: s.title };
            } catch (e) {
              this.logger.warn(`Anime TVDB-authoritative match failed for ${rawTvdbSeriesId} ("${title}") — falling back to TMDB: ${(e as Error).message}`);
            }
          }
          const mediaId =
            type === 'SHOW'
              ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year })
              : await this.meta.lightUpsertMovie({ tmdbId: hit.tmdbId, title, year });
          return { mediaId, confidence: 0.95, matchedTitle: title };
        }
      } catch (e) {
        this.logger.debug(`TMDB /find for TVDB id ${rawTvdbSeriesId} ("${title}") failed: ${(e as Error).message}`);
      }
    }

    // 0b) TMDB didn't resolve the TVDB ID → fetch from TVDB directly.
    if (this.tvdb.enabled) {
      try {
        if (type === 'SHOW') {
          const s = await this.tvdb.getShow(Number(rawTvdbSeriesId));
          const mediaId = await this.meta.lightUpsertShowTvdb({
            tvdbId: Number(rawTvdbSeriesId),
            title: s.title,
            overview: s.overview ?? null,
            posterUrl: s.posterUrl ?? null,
            backdropUrl: s.backdropUrl ?? null,
            popularity: s.popularity ?? 0,
            year: s.yearStart ?? null,
          });
          return { mediaId, confidence: 0.85, matchedTitle: s.title };
        } else {
          const mv = await this.tvdb.getMovie(Number(rawTvdbSeriesId));
          const mediaId = await this.meta.lightUpsertMovieTvdb({
            tvdbId: Number(rawTvdbSeriesId),
            title: mv.title,
            overview: mv.overview ?? null,
            posterUrl: mv.posterUrl ?? null,
            backdropUrl: mv.backdropUrl ?? null,
            popularity: mv.popularity ?? 0,
            year: mv.releaseYear ?? null,
          });
          return { mediaId, confidence: 0.85, matchedTitle: mv.title };
        }
      } catch (e) {
        this.logger.warn(`TVDB exact-id recovery failed for ${rawTvdbSeriesId}: ${(e as Error).message}`);
      }
    }

    // 0c) TVDB ID present but UNRESOLVABLE — do NOT fall back to title matching.
    this.logger.warn(
      `TVDB series ID ${rawTvdbSeriesId} for "${title}" could not be resolved via TMDB or TVDB — refusing title fallback`,
    );
    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * Multi-id authority gate: TV Time rows for one show can carry several TVDB series ids
   * (TVDB merges leave dead ids in old exports — one id may be gone while a sibling works).
   * Each id is tried through the full gate in order; the first hit wins. Title fallback is
   * refused only when EVERY id fails — an id set that cannot resolve at all returns null.
   */
  private async matchByTvdbIds(ids: string[], title: string, type: 'SHOW' | 'MOVIE', year: number | null): Promise<MediaMatch> {
    for (const id of ids) {
      const r = await this.matchByTvdbId(id, title, type, year);
      if (r.mediaId) return r;
    }
    if (ids.length > 1) {
      this.logger.warn(`None of the ${ids.length} TVDB ids for "${title}" resolved (${ids.join(', ')}) — refusing title fallback`);
    }
    return { mediaId: null, confidence: 0, matchedTitle: null };
  }

  /**
   * Show-level recovery via a TVDB EPISODE id (last resort): TV Time episode rows often carry
   * no series id, and translated titles (e.g. "The Mantis" → "La Mante") defeat title search.
   * /find on one episode id returns the parent TMDB show id — an authoritative identity for
   * the show itself. Only runs when normal show matching already failed (bounded call volume).
   */
  async recoverShowByEpisodeId(
    title: string,
    year: number | null,
    rawTvdbEpisodeId: string | number | null | undefined,
  ): Promise<MediaMatch> {
    const raw = rawTvdbEpisodeId == null ? '' : String(rawTvdbEpisodeId).trim();
    if (!raw || !this.tmdb.enabled) return { mediaId: null, confidence: 0, matchedTitle: null };
    try {
      const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
      const showId = found?.episode?.showId;
      if (!showId) return { mediaId: null, confidence: 0, matchedTitle: null };
      const mediaId = await this.meta.lightUpsertShow({ tmdbId: showId, title, year });
      return { mediaId, confidence: 0.9, matchedTitle: title };
    } catch (e) {
      this.logger.debug(`Show recovery via episode id ${raw} ("${title}") failed: ${(e as Error).message}`);
      return { mediaId: null, confidence: 0, matchedTitle: null };
    }
  }

  /**
   * The locally hydrated structure of a show: highest non-special season and, per season,
   * the highest stored episode number. Used by the structural guard to detect shows whose
   * stored structure cannot contain the import's footprint (wrong provider structure or a
   * poisoned partial hydration from a rate-limited fetch).
   */
  async hydratedFootprint(mediaId: string): Promise<{ maxSeason: number; maxEpisodeBySeason: Map<number, number> }> {
    const seasons = await this.prisma.season.findMany({
      where: { show: { mediaId } },
      select: { number: true, episodes: { select: { number: true }, orderBy: { number: 'desc' }, take: 1 } },
    });
    const maxEpisodeBySeason = new Map<number, number>();
    let maxSeason = 0;
    for (const s of seasons) {
      if (s.number > maxSeason) maxSeason = s.number;
      maxEpisodeBySeason.set(s.number, s.episodes[0]?.number ?? 0);
    }
    return { maxSeason, maxEpisodeBySeason };
  }

  /** Re-hydrate a show from TVDB (best-effort union merge into the existing structure). */
  async rehydrateWithTvdb(mediaId: string): Promise<boolean> {
    const tvdbExt = await this.prisma.externalId.findFirst({
      where: { mediaId, provider: ExternalProvider.THE_TVDB },
    });
    if (!tvdbExt || !this.tvdb?.enabled) return false;
    try {
      await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
      return true;
    } catch (e) {
      this.logger.warn(`TVDB re-hydration failed for media ${mediaId}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * External-ID-first matching for Trakt exports. Order: TMDB id (local mapping, else light
   * fetch + upsert) → TVDB id (authority gate above) → IMDB id (local mapping only) → title
   * fallback via the regular matchMedia path. An id that cannot be resolved NEVER causes a
   * wrong-title match on its own — title matching only runs when no id resolved at all.
   */
  async matchByExternalIds(
    ids: TraktIds,
    type: 'SHOW' | 'MOVIE',
    title: string,
    norm: string,
    year?: number | null,
    archiveLanguage?: SupportedLocale | null,
  ): Promise<MediaMatch> {
    const key = `ext:${type}:${ids.tmdb ?? ''}:${ids.tvdb ?? ''}:${ids.imdb ?? ''}:${norm}`;
    const cached = this.mediaCache.get(key);
    if (cached) return { mediaId: cached.mediaId, confidence: cached.confidence, matchedTitle: cached.title };
    const done = (r: MediaMatch): MediaMatch => {
      this.mediaCache.set(key, { mediaId: r.mediaId, confidence: r.confidence, title: r.matchedTitle });
      return r;
    };
    const kind = type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;

    // 1) TMDB id — preferred provider. Local mapping first; on a miss create/locate the media
    //    by id (shows use the export's title+year — getShow would fetch every season, and a
    //    matched show is fully hydrated afterwards by ensureShowHydrated anyway).
    if (ids.tmdb) {
      const ext = await this.prisma.externalId.findFirst({
        where: { provider: ExternalProvider.TMDB, providerEntityKind: kind, value: String(ids.tmdb) },
        include: { media: true },
      });
      if (ext?.media) {
        return done({ mediaId: ext.media.id, confidence: 0.95, matchedTitle: ext.media.title });
      }
      if (this.tmdb.enabled) {
        try {
          if (type === 'SHOW') {
            const mediaId = await this.meta.lightUpsertShow({ tmdbId: ids.tmdb, title, year: year ?? null });
            return done({ mediaId, confidence: 0.95, matchedTitle: title });
          }
          const m = await this.tmdb.getMovie(ids.tmdb);
          const mediaId = await this.meta.lightUpsertMovie({
            tmdbId: m.tmdbId,
            title: m.title,
            overview: m.overview ?? null,
            posterUrl: m.posterUrl ?? null,
            backdropUrl: m.backdropUrl ?? null,
            rating: m.rating ?? null,
            popularity: m.popularity ?? null,
            year: m.releaseYear ?? null,
          });
          return done({ mediaId, confidence: 0.95, matchedTitle: m.title });
        } catch (e) {
          this.logger.debug(`TMDB id ${ids.tmdb} upsert failed for "${title}" — falling through: ${(e as Error).message}`);
        }
      }
    }

    // 2) TVDB id — authority gate (no title fallback inside).
    if (ids.tvdb) {
      const r = await this.matchByTvdbId(String(ids.tvdb), title, type, year ?? null);
      if (r.mediaId) return done(r);
    }

    // 3) IMDB id — local mapping first, then an exact /find recovery.
    if (ids.imdb) {
      const ext = await this.prisma.externalId.findFirst({
        where: { provider: ExternalProvider.IMDB, providerEntityKind: kind, value: ids.imdb },
        include: { media: true },
      });
      if (ext?.media) {
        return done({ mediaId: ext.media.id, confidence: 0.9, matchedTitle: ext.media.title });
      }
      if (this.tmdb.enabled) {
        try {
          const found = await this.tmdb.findByExternalId(ids.imdb, 'imdb_id');
          const hit = type === 'SHOW' ? found?.show : found?.movie;
          if (hit) {
            const mediaId =
              type === 'SHOW'
                ? await this.meta.lightUpsertShow({ tmdbId: hit.tmdbId, title, year: year ?? null })
                : await this.meta.lightUpsertMovie({ tmdbId: hit.tmdbId, title, year: year ?? null });
            return done({ mediaId, confidence: 0.9, matchedTitle: title });
          }
        } catch (e) {
          this.logger.debug(`IMDB /find for ${ids.imdb} ("${title}") failed: ${(e as Error).message}`);
        }
      }
    }

    // 4) No id resolved → regular title matching (matchMedia without a raw TVDB id).
    const r = await this.matchMedia(norm, title, type, year, undefined, archiveLanguage);
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
    const candidates: { provider: ExternalProvider; value: string }[] = [];
    if (ids.tmdb) candidates.push({ provider: ExternalProvider.TMDB, value: String(ids.tmdb) });
    if (ids.tvdb) candidates.push({ provider: ExternalProvider.THE_TVDB, value: String(ids.tvdb) });
    for (const c of candidates) {
      const cacheKey = `ext-ep:${mediaId}:${c.provider}:${c.value}`;
      if (this.episodeCache.has(cacheKey)) return this.episodeCache.get(cacheKey)!;
      const ext = await this.prisma.episodeExternalId.findFirst({
        where: {
          provider: c.provider,
          providerEntityKind: ProviderEntityKind.EPISODE,
          value: c.value,
          episode: { season: { show: { mediaId } } },
        },
        select: { episodeId: true },
      });
      if (ext?.episodeId) {
        this.episodeCache.set(cacheKey, ext.episodeId);
        return ext.episodeId;
      }
    }
    return null;
  }

  /**
   * Episode /find recovery for TV Time rows: translate the TVDB episode id via TMDB /find —
   * the response carries TMDB's OWN season/episode numbers (and the parent show), so the
   * final S/E lookup is consistent with the TMDB-hydrated structure even when TVDB numbering
   * differs. Runs ONLY when local resolution (external id + S/E) already failed, so call
   * volume stays bounded to problem episodes. The found TMDB episode id is attached to the
   * resolved episode (best-effort) so later imports hit the local fast path.
   */
  async recoverEpisodeByTvdbId(mediaId: string, rawTvdbEpisodeId: string | number | null | undefined): Promise<string | null> {
    const raw = rawTvdbEpisodeId == null ? '' : String(rawTvdbEpisodeId).trim();
    if (!raw || !this.tmdb.enabled) return null;
    const found = await this.tmdb.findByExternalId(raw, 'tvdb_id');
    const ep = found?.episode;
    if (!ep) return null;
    // Safety: when the matched media has a TMDB id, the episode must belong to that show.
    const tmdbExt = await this.prisma.externalId.findFirst({
      where: { mediaId, provider: ExternalProvider.TMDB },
    });
    if (tmdbExt && String(ep.showId) !== tmdbExt.value) return null;
    const episodeId = await this.resolveEpisode(mediaId, ep.season, ep.episode);
    if (episodeId) {
      await this.attachEpisodeExternalId(episodeId, ExternalProvider.TMDB, String(ep.tmdbEpisodeId));
    }
    return episodeId;
  }

  /** Best-effort attach of an external id to a media row (skips silently on unique conflicts). */
  private async attachExternalId(mediaId: string, provider: ExternalProvider, kind: ProviderEntityKind, value: string) {
    try {
      await this.prisma.externalId.create({ data: { mediaId, provider, providerEntityKind: kind, value } });
    } catch {
      // Another row already owns this (provider, kind, value) pair — fine.
    }
  }

  /** Best-effort attach of an external id to an episode (repoints on unique conflict). */
  private async attachEpisodeExternalId(episodeId: string, provider: ExternalProvider, value: string) {
    try {
      await this.prisma.episodeExternalId.upsert({
        where: {
          provider_providerEntityKind_value: { provider, providerEntityKind: ProviderEntityKind.EPISODE, value },
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
   * Among qualified candidates, the closest fit wins (fewest extra seasons, then smallest
   * deficit). Returns null if there's no meaningful decision (caller keeps the default pick).
   */
  private async disambiguateShow<T extends { tmdbId: number; title: string }>(
    candidates: T[],
    hint: { maxSeason?: number | null; seasonEpisodes?: { season: number; maxEpisode: number }[] | null },
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
          let deficit = 0; // total episodes short across referenced seasons
          for (const [season, maxEp] of epBySeason) {
            const cand = seasonEpCounts.get(season) ?? 0;
            if (cand < maxEp) {
              qualified = false;
              deficit += maxEp - cand;
            }
          }
          const extraSeasons = Math.max(0, totalSeasons - maxSeason);
          return { item: c, totalSeasons, qualified, extraSeasons, deficit };
        } catch {
          return null;
        }
      }),
    );

    type Score = { item: T; totalSeasons: number; qualified: boolean; extraSeasons: number; deficit: number };
    const valid = scored.filter(Boolean) as Score[];

    const qualified = valid
      .filter((d) => d.qualified)
      .sort((a, b) => a.extraSeasons - b.extraSeasons || a.deficit - b.deficit);
    if (qualified.length) return qualified[0].item;

    // None fully fit the footprint — best effort: pick the closest (smallest episode deficit,
    // then the one with the most seasons). Only when there's real ambiguity.
    if (valid.length > 1) {
      return [...valid].sort((a, b) => a.deficit - b.deficit || b.totalSeasons - a.totalSeasons)[0].item;
    }
    return null;
  }

  /** Ensure a show has seasons/episodes in DB (needed to resolve episode by S/E). Skips if already hydrated. */
  async ensureShowHydrated(mediaId: string) {
    // Already hydrated? Then there's nothing to fetch — this is what makes re-imports fast.
    const epCount = await this.prisma.episode.count({ where: { season: { show: { mediaId } } } });
    if (epCount > 0) return;

    const [tmdbExt, tvdbExt] = await Promise.all([
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.TMDB } }),
      this.prisma.externalId.findFirst({ where: { mediaId, provider: ExternalProvider.THE_TVDB } }),
    ]);

    // Anime shows matched via the TVDB-authoritative branch hydrate from TVDB first:
    // TMDB anime season/episode structures are unreliable.
    if (this.providerPref.get(mediaId) === 'tvdb' && tvdbExt && this.tvdb?.enabled) {
      try {
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value));
        return;
      } catch {
        // Fall through to TMDB.
      }
    }

    // Try TMDB first (preferred provider).
    if (tmdbExt && this.tmdb.enabled) {
      try {
        await this.meta.ensureShowFull(Number(tmdbExt.value));
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
        await this.meta.ensureShowFullTvdb(Number(tvdbExt.value)).catch(() => undefined);
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
  async resolveEpisode(mediaId: string, season: number, episode: number, lenient = false): Promise<string | null> {
    const key = `${mediaId}:${season}:${episode}:${lenient ? 'l' : 's'}`;
    if (this.episodeCache.has(key)) return this.episodeCache.get(key)!;
    let ep = await this.prisma.episode.findFirst({
      where: { season: { show: { mediaId }, number: season }, number: episode },
    });
    if (!ep && lenient && season !== 0) {
      // Fallback: same episode number in the lowest non-special season of the show.
      ep = await this.prisma.episode.findFirst({
        where: { season: { show: { mediaId }, number: { not: 0 } }, number: episode },
        orderBy: { season: { number: 'asc' } },
      });
    }
    const id = ep?.id ?? null;
    // Only cache POSITIVE results — never cache null (the show may get hydrated later).
    if (id) this.episodeCache.set(key, id);
    return id;
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
 * hydration (rate-limited fetch stored 1 episode). The processor reacts by re-hydrating
 * from TVDB (union upsert — existing rows are never deleted).
 */
export function needsTvdbRehydration(
  footprint: { maxSeason?: number | null; seasonEpisodes?: { season: number; maxEpisode: number }[] | null },
  hydrated: { maxSeason: number; maxEpisodeBySeason: Map<number, number> },
): boolean {
  if (footprint.maxSeason != null && footprint.maxSeason > 0 && hydrated.maxSeason < footprint.maxSeason) {
    return true;
  }
  for (const se of footprint.seasonEpisodes ?? []) {
    if (se.season === 0) continue; // specials are optional everywhere
    if ((hydrated.maxEpisodeBySeason.get(se.season) ?? 0) < se.maxEpisode) return true;
  }
  return false;
}
