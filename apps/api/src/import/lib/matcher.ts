import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider, MediaType, ProviderEntityKind, type SupportedLocale } from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { runInLanguage, currentLanguage } from '../../common/language.context';
import { MediaMetadataService } from '../../media-metadata/media-metadata.service';
import { TmdbProvider } from '../../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../../media-metadata/providers/tvdb.provider';
import { normTitle } from './inference';

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
  private readonly mediaCache = new Map<string, { mediaId: string; confidence: number; title: string }>();
  private readonly episodeCache = new Map<string, string | null>();

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
     * Raw TVDB series id from a TV Time export (s_id/series_id/tv_show_id). This is a
     * recovery/disambiguation signal only — it is reused from local mappings without any
     * external call, and resolved exactly via TVDB ONLY when normal matching fails.
     */
    rawTvdbSeriesId?: string | null,
  ): Promise<{ mediaId: string | null; confidence: number; matchedTitle: string | null }> {
    const key = `${type}:${norm}`;
    const cached = this.mediaCache.get(key);
    if (cached) return { mediaId: cached.mediaId, confidence: cached.confidence, matchedTitle: cached.title };

    const mediaType = type === 'SHOW' ? MediaType.SHOW : MediaType.MOVIE;

    // 0) Reuse a VERIFIED LOCAL TVDB mapping for the imported raw series id — no external call.
    //    This makes 8,000 episode rows of one show resolve to one local record with zero requests.
    if (rawTvdbSeriesId) {
      const ext = await this.prisma.externalId.findFirst({
        where: {
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: ProviderEntityKind.SERIES,
          value: rawTvdbSeriesId,
        },
        include: { media: true },
      });
      if (ext?.media) {
        const confidence = 0.95;
        this.mediaCache.set(key, { mediaId: ext.media.id, confidence, title: ext.media.title });
        return { mediaId: ext.media.id, confidence, matchedTitle: ext.media.title };
      }
    }

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

    // 5) Conditional TVDB exact-id recovery — ONLY for items still unresolved after steps 1–4.
    //    A confident TMDB/local match above already returned, so this never fires merely
    //    because a raw TVDB id exists. The imported TVDB id is authoritative here.
    if (rawTvdbSeriesId && this.tvdb.enabled) {
      try {
        const tvdbIdNum = Number(rawTvdbSeriesId);
        if (type === 'SHOW') {
          const s = await this.tvdb.getShow(tvdbIdNum);
          const mediaId = await this.meta.lightUpsertShowTvdb({
            tvdbId: tvdbIdNum,
            title: s.title,
            overview: s.overview ?? null,
            posterUrl: s.posterUrl ?? null,
            backdropUrl: s.backdropUrl ?? null,
            popularity: s.popularity ?? 0,
            year: s.yearStart ?? null,
          });
          const confidence = 0.85;
          this.mediaCache.set(key, { mediaId, confidence, title: s.title });
          return { mediaId, confidence, matchedTitle: s.title };
        } else {
          const mv = await this.tvdb.getMovie(tvdbIdNum);
          const mediaId = await this.meta.lightUpsertMovieTvdb({
            tvdbId: tvdbIdNum,
            title: mv.title,
            overview: mv.overview ?? null,
            posterUrl: mv.posterUrl ?? null,
            backdropUrl: mv.backdropUrl ?? null,
            popularity: mv.popularity ?? 0,
            year: mv.releaseYear ?? null,
          });
          const confidence = 0.85;
          this.mediaCache.set(key, { mediaId, confidence, title: mv.title });
          return { mediaId, confidence, matchedTitle: mv.title };
        }
      } catch (e) {
        this.logger.warn(`TVDB exact-id recovery failed for ${rawTvdbSeriesId}: ${(e as Error).message}`);
      }
    }

    return { mediaId: null, confidence: 0, matchedTitle: null };
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
    // Already hydrated? Then there's nothing to fetch from TMDb — this is what makes re-imports fast.
    const epCount = await this.prisma.episode.count({ where: { season: { show: { mediaId } } } });
    if (epCount > 0) return;
    const ext = await this.prisma.externalId.findFirst({
      where: { mediaId, provider: ExternalProvider.TMDB },
    });
    if (ext && this.tmdb.enabled) {
      try {
        await this.meta.ensureShowFull(Number(ext.value));
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
    this.episodeCache.set(key, id);
    return id;
  }

  classify(confidence: number): 'matched' | 'needs_review' | 'unmatched' {
    if (confidence >= 0.7) return 'matched';
    if (confidence >= 0.45) return 'needs_review';
    return 'unmatched';
  }
}
