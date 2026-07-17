import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExternalProvider, MediaType, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { currentLanguage } from '../common/language.context';
import { mergeLocalized } from '../common/utils/localization.util';
import { mapMovie, mapSeason, mapShow } from '../common/utils/mapper.util';
import {
  NormalizedMovie,
  NormalizedSeason,
  NormalizedShow,
  TmdbProvider,
} from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';
import { HydrationQueue } from './hydration/hydration.queue';
import { slugify } from './util/slugify';

/** Metadata is considered stale (eligible for a full refresh) after 24h. */
const DAY_MS = 1000 * 60 * 60 * 24;

@Injectable()
export class MediaMetadataService {
  private readonly logger = new Logger(MediaMetadataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly tvmaze: TvmazeProvider,
    private readonly config: ConfigService,
    private readonly hydration: HydrationQueue,
  ) {}

  /** Enqueue classification, versioned by metadataRefreshedAt so each re-hydration re-runs
   *  once (not deduped against the earlier search-stub classify). Called on detail view. */
  async scheduleClassification(mediaId: string): Promise<void> {
    const r = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: { metadataRefreshedAt: true },
    });
    await this.hydration
      .enqueueClassifyCandidate({ mediaId }, String(r?.metadataRefreshedAt?.getTime() ?? 0))
      .catch(() => undefined);
  }

  get tmdbEnabled() {
    return this.tmdb.enabled;
  }

  get tvdbEnabled() {
    return this.tvdb?.enabled ?? false;
  }

  // ---- External lookup ----
  async findMediaByExternal(provider: ExternalProvider, value: string) {
    // Kind-agnostic read: a verified (provider,value) is unique within a kind; findFirst
    // across kinds keeps existing callers compatible with the namespace-aware schema.
    const ext = await this.prisma.externalId.findFirst({
      where: { provider, value },
      include: { media: true },
    });
    return ext?.media ?? null;
  }

  /** Namespace kind for media-level externals, derived from the structural media type. */
  private static kindOf(type: MediaType): ProviderEntityKind {
    return type === MediaType.SHOW ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
  }

  /** Fetch the English base (title/overview/images) for a new TMDB media row, so the
   *  shared row is never created stuck in a single user's language. Best-effort. */
  private async fetchEnBase(type: MediaType, tmdbId: number) {
    if (!this.tmdb.enabled) return undefined;
    try {
      return type === MediaType.SHOW
        ? await this.tmdb.localizedShowBase(tmdbId, 'en-US')
        : await this.tmdb.localizedMovieBase(tmdbId, 'en-US');
    } catch {
      return undefined;
    }
  }

  /** Localized create fields for a NEW media row: English base (when available) plus
   *  the request-locale override. The base columns hold English so every language
   *  reads correctly via `override[lang] ?? override['en'] ?? base`. */
  private newMediaLocaleFields(
    item: { title: string; overview?: string | null; posterUrl?: string | null; backdropUrl?: string | null },
    enBase: { title?: string; overview?: string | null; posterUrl?: string | null; backdropUrl?: string | null } | undefined,
    lang: string,
  ) {
    return {
      title: enBase?.title ?? item.title,
      overview: enBase?.overview ?? item.overview,
      posterUrl: enBase?.posterUrl ?? item.posterUrl,
      backdropUrl: enBase?.backdropUrl ?? item.backdropUrl,
      titleLocale: enBase ? 'en' : lang,
      titles: mergeLocalized(mergeLocalized(null, 'en', enBase?.title, undefined), lang, item.title, undefined),
      overviews: mergeLocalized(mergeLocalized(null, 'en', enBase?.overview, undefined), lang, item.overview, undefined),
      posterUrls: mergeLocalized(mergeLocalized(null, 'en', enBase?.posterUrl, undefined), lang, item.posterUrl, undefined),
      backdropUrls: mergeLocalized(mergeLocalized(null, 'en', enBase?.backdropUrl, undefined), lang, item.backdropUrl, undefined),
    };
  }

  // ---- Light upsert for list endpoints ----
  async lightUpsertShow(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    if (existing) {
      // List data is single-language: store it as a locale override only, never
      // overwriting the (English) base so other users aren't contaminated.
      await this.prisma.mediaItem.update({
        where: { id: existing.id },
        data: {
          titles: mergeLocalized(existing.titles as any, lang, item.title, undefined),
          overviews: mergeLocalized(existing.overviews as any, lang, item.overview, undefined),
          posterUrls: mergeLocalized(existing.posterUrls as any, lang, item.posterUrl, undefined),
          backdropUrls: mergeLocalized(existing.backdropUrls as any, lang, item.backdropUrl, undefined),
        },
      });
      // Backfill a missing year on stubs created before search mapped the year.
      if (item.year) {
        await this.prisma.show
          .updateMany({ where: { mediaId: existing.id, yearStart: null }, data: { yearStart: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(item, await this.fetchEnBase(MediaType.SHOW, item.tmdbId), lang),
          type: MediaType.SHOW,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          show: {
            create: { yearStart: item.year ?? null, inProduction: true },
          },
          externalIds: {
            create: [{ provider: ExternalProvider.TMDB, providerEntityKind: ProviderEntityKind.SERIES, value: tmdbVal }],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      // Race condition: another concurrent call (search/import) created this media first.
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
        if (found) return found.id;
      }
      throw e;
    }
  }

  async lightUpsertMovie(item: {
    tmdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tmdbVal = String(item.tmdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    if (existing) {
      await this.prisma.mediaItem.update({
        where: { id: existing.id },
        data: {
          titles: mergeLocalized(existing.titles as any, lang, item.title, undefined),
          overviews: mergeLocalized(existing.overviews as any, lang, item.overview, undefined),
          posterUrls: mergeLocalized(existing.posterUrls as any, lang, item.posterUrl, undefined),
          backdropUrls: mergeLocalized(existing.backdropUrls as any, lang, item.backdropUrl, undefined),
        },
      });
      if (item.year) {
        await this.prisma.movie
          .updateMany({ where: { mediaId: existing.id, releaseYear: null }, data: { releaseYear: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(item, await this.fetchEnBase(MediaType.MOVIE, item.tmdbId), lang),
          type: MediaType.MOVIE,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          movie: { create: { releaseYear: item.year ?? null } },
          externalIds: { create: [{ provider: ExternalProvider.TMDB, providerEntityKind: ProviderEntityKind.MOVIE, value: tmdbVal }] },
        },
      });
      return created.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
        if (found) return found.id;
      }
      throw e;
    }
  }

  async lightUpsertShowTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    if (existing) {
      await this.prisma.mediaItem.update({
        where: { id: existing.id },
        data: {
          titles: mergeLocalized(existing.titles as any, lang, item.title, undefined),
          overviews: mergeLocalized(existing.overviews as any, lang, item.overview, undefined),
          posterUrls: mergeLocalized(existing.posterUrls as any, lang, item.posterUrl, undefined),
          backdropUrls: mergeLocalized(existing.backdropUrls as any, lang, item.backdropUrl, undefined),
        },
      });
      if (item.year) {
        await this.prisma.show
          .updateMany({ where: { mediaId: existing.id, yearStart: null }, data: { yearStart: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }

    const byTitle = await this.prisma.mediaItem.findFirst({
      where: { title: { equals: item.title, mode: 'insensitive' }, type: MediaType.SHOW },
    });
    if (byTitle) {
      await this.prisma.externalId
        .create({ data: { provider: ExternalProvider.THE_TVDB, providerEntityKind: ProviderEntityKind.SERIES, value: tvdbVal, mediaId: byTitle.id } })
        .catch(() => undefined);
      return byTitle.id;
    }

    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.SHOW,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        popularity: item.popularity ?? 0,
        titleLocale: lang,
        titles: mergeLocalized(null, lang, item.title, undefined),
        overviews: mergeLocalized(null, lang, item.overview, undefined),
        posterUrls: mergeLocalized(null, lang, item.posterUrl, undefined),
        backdropUrls: mergeLocalized(null, lang, item.backdropUrl, undefined),
        show: { create: { yearStart: item.year ?? null, inProduction: true } },
        externalIds: { create: [{ provider: ExternalProvider.THE_TVDB, providerEntityKind: ProviderEntityKind.SERIES, value: tvdbVal }] },
      },
    });
    return created.id;
  }

  /** Light-upsert a movie resolved from TVDB (backup provider). */
  async lightUpsertMovieTvdb(item: {
    tvdbId: number;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const lang = currentLanguage();
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    if (existing) {
      await this.prisma.mediaItem.update({
        where: { id: existing.id },
        data: {
          titles: mergeLocalized(existing.titles as any, lang, item.title, undefined),
          overviews: mergeLocalized(existing.overviews as any, lang, item.overview, undefined),
          posterUrls: mergeLocalized(existing.posterUrls as any, lang, item.posterUrl, undefined),
          backdropUrls: mergeLocalized(existing.backdropUrls as any, lang, item.backdropUrl, undefined),
        },
      });
      if (item.year) {
        await this.prisma.movie
          .updateMany({ where: { mediaId: existing.id, releaseYear: null }, data: { releaseYear: item.year } })
          .catch(() => undefined);
      }
      return existing.id;
    }

    const byTitle = await this.prisma.mediaItem.findFirst({
      where: { title: { equals: item.title, mode: 'insensitive' }, type: MediaType.MOVIE },
    });
    if (byTitle) {
      await this.prisma.externalId
        .create({ data: { provider: ExternalProvider.THE_TVDB, providerEntityKind: ProviderEntityKind.MOVIE, value: tvdbVal, mediaId: byTitle.id } })
        .catch(() => undefined);
      return byTitle.id;
    }

    const created = await this.prisma.mediaItem.create({
      data: {
        type: MediaType.MOVIE,
        title: item.title,
        overview: item.overview,
        posterUrl: item.posterUrl,
        backdropUrl: item.backdropUrl,
        popularity: item.popularity ?? 0,
        titleLocale: lang,
        titles: mergeLocalized(null, lang, item.title, undefined),
        overviews: mergeLocalized(null, lang, item.overview, undefined),
        posterUrls: mergeLocalized(null, lang, item.posterUrl, undefined),
        backdropUrls: mergeLocalized(null, lang, item.backdropUrl, undefined),
        movie: { create: { releaseYear: item.year ?? null } },
        externalIds: { create: [{ provider: ExternalProvider.THE_TVDB, providerEntityKind: ProviderEntityKind.MOVIE, value: tvdbVal }] },
      },
    });
    return created.id;
  }

  /** Populate the request-locale override (media title/overview/images) for list
   *  items that are missing it, so user-specific lists (watchlist/favorites/library)
   *  display localized without each item having been opened in detail first.
   *  Best-effort, one lightweight TMDb call per missing item (cached afterwards).
   *  Capped per call to avoid hammering TMDb on large lists; remaining items are
   *  localized on subsequent calls (already-localized ones are skipped). */
  async ensureListLocaleOverrides(mediaIds: string[]) {
    const lang = currentLanguage();
    if (lang === 'en' || !this.tmdb.enabled || mediaIds.length === 0) return;
    const rows = await this.prisma.mediaItem.findMany({
      where: { id: { in: mediaIds } },
      select: {
        id: true,
        type: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        backdropUrls: true,
        externalIds: { select: { provider: true, value: true } },
      },
    });
    const missing = rows.filter((m) => !((m.titles as any)?.[lang]));
    const toFetch = missing.slice(0, 100); // bound TMDb calls per request (TMDb paces starts at ~40rps)
    await Promise.all(
      toFetch.map(async (m) => {
        const titles = m.titles as any;
        const tmdb = m.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
        if (!tmdb) return;
        try {
          const base =
            m.type === MediaType.SHOW
              ? await this.tmdb.localizedShowBase(Number(tmdb.value), lang)
              : await this.tmdb.localizedMovieBase(Number(tmdb.value), lang);
          await this.prisma.mediaItem.update({
            where: { id: m.id },
            data: {
              titles: mergeLocalized(titles, lang, base.title, undefined),
              overviews: mergeLocalized(m.overviews as any, lang, base.overview, undefined),
              posterUrls: mergeLocalized(m.posterUrls as any, lang, base.posterUrl, undefined),
              backdropUrls: mergeLocalized(m.backdropUrls as any, lang, base.backdropUrl, undefined),
            },
          });
        } catch {
          // best-effort: leave English fallback for this item
        }
      }),
    );
  }

  /** Populate the request-locale override for EPISODES (title/overview/still) that
   *  are missing it, so episode titles localize in watch-next rails and episode
   *  detail without the show having been opened in detail first. Best-effort.
   *  Capped per call to avoid hammering TMDb on large lists; remaining episodes are
   *  localized on subsequent calls (already-localized ones are skipped). */
  async ensureEpisodeLocaleOverrides(episodeIds: string[]) {
    const lang = currentLanguage();
    if (lang === 'en' || !this.tmdb.enabled || episodeIds.length === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { id: { in: episodeIds } },
      select: {
        id: true,
        number: true,
        titles: true,
        overviews: true,
        stillUrls: true,
        season: {
          select: {
            number: true,
            show: { select: { media: { select: { externalIds: { select: { provider: true, value: true } } } } } },
          },
        },
      },
    });
    const missing = eps.filter((ep) => !(ep.titles as any)?.[lang]);
    const toFetch = missing.slice(0, 100); // bound TMDb calls per request (TMDb paces starts at ~40rps)
    await Promise.all(
      toFetch.map(async (ep) => {
        const tmdb = ep.season.show.media.externalIds.find((e) => e.provider === ExternalProvider.TMDB);
        if (!tmdb) return;
        try {
          const base = await this.tmdb.localizedEpisodeBase(
            Number(tmdb.value),
            ep.season.number,
            ep.number,
            lang,
          );
          await this.prisma.episode.update({
            where: { id: ep.id },
            data: {
              titles: mergeLocalized(ep.titles as any, lang, base.title, undefined),
              overviews: mergeLocalized(ep.overviews as any, lang, base.overview, undefined),
              stillUrls: mergeLocalized(ep.stillUrls as any, lang, base.stillUrl, undefined),
            },
          });
        } catch {
          // best-effort: leave English fallback for this episode
        }
      }),
    );
  }

  // ---- Full show/movie hydration ----
  /** A media row needs a full refresh when missing or older than 24h. */
  private isStale(existing: { metadataRefreshedAt?: Date | null } | null): boolean {
    return !existing || !existing.metadataRefreshedAt || Date.now() - existing.metadataRefreshedAt.getTime() > DAY_MS;
  }

  async ensureShowFull(tmdbId: number, userId?: string): Promise<string> {
    const lang = currentLanguage();
    const data = await this.tmdb.getShow(tmdbId); // request locale (L)
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    let mediaId: string;
    if (this.isStale(existing)) {
      // Full refresh: English base + all relations + the request-locale overrides.
      const enData = lang !== 'en' ? await this.tmdb.getShow(tmdbId, 'en-US') : undefined;
      mediaId = await this.persistShow(data, existing?.id, lang, enData);
    } else if (lang !== 'en' && existing) {
      // Fresh trusted base: store ONLY the request-locale override — no base change,
      // no English re-fetch — so different users' languages never contaminate each other.
      mediaId = existing.id;
      await this.applyLocaleOverrides(mediaId, MediaType.SHOW, data, lang);
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    // Fill precise air times/dates from TVmaze (best-effort, outside the tx).
    await this.enrichAirtimes(mediaId, data.externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    // Genres are now persisted → run anime candidate detection (idempotent, deduped).
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  async ensureShowFullTvdb(tvdbId: number, userId?: string): Promise<string> {
    const lang = currentLanguage();
    const data = await this.tvdb.getShow(tvdbId, lang); // pass locale → episodes get correct language
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    let mediaId: string;
    if (this.isStale(existing)) {
      const enData = lang !== 'en' ? await this.tvdb.getShow(tvdbId, 'en') : undefined;
      mediaId = await this.persistShow(data, existing?.id, lang, enData);
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.applyLocaleOverrides(mediaId, MediaType.SHOW, data, lang);
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    await this.enrichAirtimes(mediaId, data.externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  /** Fully hydrate a movie resolved from TVDB. ONE call — meta=translations returns ALL locales. */
  async ensureMovieFullTvdb(tvdbId: number): Promise<string> {
    const lang = currentLanguage();
    const data = await this.tvdb.getMovie(tvdbId, lang);
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.THE_TVDB, tvdbVal);
    let mediaId: string;
    if (this.isStale(existing)) {
      // No second call needed: data.translations already has ALL locales (including English).
      // persistMovie bulk-stores them all via mergeLocalized.
      mediaId = await this.persistMovie(data, existing?.id, lang, undefined);
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.applyLocaleOverrides(mediaId, MediaType.MOVIE, data, lang);
    } else {
      mediaId = existing!.id;
    }
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  /**
   * Store ONLY the request-locale overrides (titles/overviews/images, plus season
   * & episode text for shows) for a media whose English base is already fresh and
   * trusted. Base columns are never touched, so one user's language can't overwrite
   * another's. Cast character names and genre names are not localized here (they
   * refresh with the periodic full hydrate); this keeps the path cheap (one fetch).
   */
  private async applyLocaleOverrides(
    mediaId: string,
    type: MediaType,
    data: NormalizedShow | NormalizedMovie,
    lang: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const media = await tx.mediaItem.findUnique({
        where: { id: mediaId },
        select: { titles: true, overviews: true, posterUrls: true, backdropUrls: true },
      });
      if (media) {
        await tx.mediaItem.update({
          where: { id: mediaId },
          data: {
            titles: mergeLocalized(media.titles as any, lang, data.title, undefined),
            overviews: mergeLocalized(media.overviews as any, lang, data.overview, undefined),
            posterUrls: mergeLocalized(media.posterUrls as any, lang, data.posterUrl, undefined),
            backdropUrls: mergeLocalized(media.backdropUrls as any, lang, data.backdropUrl, undefined),
          },
        });
      }
      if (type !== MediaType.SHOW) return;
      const show = await tx.show.findUnique({ where: { mediaId }, select: { id: true } });
      if (!show) return;
      const seasons = (data as NormalizedShow).seasons ?? [];
      const existingSeasons = await tx.season.findMany({
        where: { showId: show.id },
        select: {
          id: true,
          number: true,
          titles: true,
          overviews: true,
          posterUrls: true,
          episodes: { select: { id: true, number: true, titles: true, overviews: true, stillUrls: true } },
        },
      });
      const seasonMap = new Map(existingSeasons.map((s) => [s.number, s]));
      for (const s of seasons) {
        const prev = seasonMap.get(s.number);
        if (!prev) continue;
        await tx.season.update({
          where: { id: prev.id },
          data: {
            titles: mergeLocalized(prev.titles as any, lang, s.title, undefined),
            overviews: mergeLocalized(prev.overviews as any, lang, s.overview, undefined),
            posterUrls: mergeLocalized(prev.posterUrls as any, lang, s.posterUrl, undefined),
          },
        });
        const epMap = new Map(prev.episodes.map((e) => [e.number, e]));
        for (const e of s.episodes) {
          const prevEp = epMap.get(e.number);
          if (!prevEp) continue;
          await tx.episode.update({
            where: { id: prevEp.id },
            data: {
              titles: mergeLocalized(prevEp.titles as any, lang, e.title, undefined),
              overviews: mergeLocalized(prevEp.overviews as any, lang, e.overview, undefined),
              stillUrls: mergeLocalized(prevEp.stillUrls as any, lang, e.stillUrl, undefined),
            },
          });
        }
      }
    });
  }

  private async enrichAirtimes(mediaId: string, externals: { provider: ExternalProvider; value: string }[]) {
    if (!this.tvmaze.enabled) return;
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB)?.value;
    const imdb = externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
    const map = await this.tvmaze.getEpisodeAirTimes(tvdb, imdb);
    if (map.size === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { season: { show: { mediaId } } },
      select: { id: true, number: true, season: { select: { number: true } } },
    });
    for (const e of eps) {
      const air = map.get(`${e.season.number}-${e.number}`);
      if (!air) continue;
      await this.prisma.episode.update({
        where: { id: e.id },
        data: {
          airTime: air.airtime ?? null,
          ...(air.airstamp ? { airDate: new Date(air.airstamp) } : {}),
        },
      });
    }
  }

  /** Populate per-episode air times from TVmaze if any are missing (idempotent / cached). */
  async ensureAirtimes(mediaId: string) {
    if (!this.tvmaze.enabled) return;
    const missing = await this.prisma.episode.count({
      where: { season: { show: { mediaId } }, airTime: null },
    });
    if (missing === 0) return;
    const exts = await this.prisma.externalId.findMany({
      where: { mediaId },
      select: { provider: true, value: true },
    });
    await this.enrichAirtimes(mediaId, exts as any);
  }

  async ensureMovieFull(tmdbId: number): Promise<string> {
    const lang = currentLanguage();
    const data = await this.tmdb.getMovie(tmdbId); // request locale (L)
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(ExternalProvider.TMDB, tmdbVal);
    let mediaId: string;
    if (this.isStale(existing)) {
      const enData = lang !== 'en' ? await this.tmdb.getMovie(tmdbId, 'en-US') : undefined;
      mediaId = await this.persistMovie(data, existing?.id, lang, enData);
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.applyLocaleOverrides(mediaId, MediaType.MOVIE, data, lang);
    } else {
      mediaId = existing!.id;
    }
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  private async persistShow(
    data: NormalizedShow,
    existingId?: string,
    lang: string = currentLanguage(),
    enData?: NormalizedShow,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      // Existing JSON (to merge locale overrides without clobbering other locales).
      const prev = existingId
        ? await tx.mediaItem.findUnique({
            where: { id: existingId },
            select: { titles: true, overviews: true, posterUrls: true, backdropUrls: true, titleLocale: true },
          })
        : null;
      const base = enData ?? data; // English base when available, else the fetched locale
      const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
      const providers = await this.upsertProviders(tx, data.providers);
      const castMembers = await this.upsertCast(tx, data.cast);

      const mediaData = {
        title: base.title,
        overview: base.overview,
        posterUrl: base.posterUrl,
        backdropUrl: base.backdropUrl,
        rating: data.rating,
        status: data.status,
        popularity: data.popularity ?? 0,
        trailerUrl: data.trailerUrl,
        metadataRefreshedAt: new Date(),
        titleLocale: enData ? 'en' : (prev?.titleLocale ?? lang),
        titles: mergeLocalized(prev?.titles as any, lang, data.title, enData?.title),
        overviews: mergeLocalized(prev?.overviews as any, lang, data.overview, enData?.overview),
        posterUrls: mergeLocalized(prev?.posterUrls as any, lang, data.posterUrl, enData?.posterUrl),
        backdropUrls: mergeLocalized(prev?.backdropUrls as any, lang, data.backdropUrl, enData?.backdropUrl),
      };

      let mediaId = existingId;
      if (existingId) {
        await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
      } else {
        const created = await tx.mediaItem.create({
          data: {
            ...mediaData,
            type: MediaType.SHOW,
            externalIds: {
              create: data.externals.map((e) => ({
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: e.value,
              })),
            },
          },
        });
        mediaId = created.id;
      }

      // upsert externals (in case new ones appeared)
      for (const e of data.externals) {
        await tx.externalId.upsert({
          where: { provider_providerEntityKind_value: { provider: e.provider, providerEntityKind: ProviderEntityKind.SERIES, value: e.value } },
          create: { mediaId: mediaId!, provider: e.provider, providerEntityKind: ProviderEntityKind.SERIES, value: e.value },
          update: {},
        });
      }

      await tx.show.upsert({
        where: { mediaId: mediaId! },
        create: {
          mediaId: mediaId!,
          yearStart: data.yearStart,
          yearEnd: data.yearEnd,
          network: data.network,
          runtimeMinutes: data.runtimeMinutes,
          nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
          seasonsCount: data.seasonsCount,
          episodesCount: data.episodesCount,
          inProduction: data.inProduction,
        },
        update: {
          yearStart: data.yearStart,
          yearEnd: data.yearEnd,
          network: data.network,
          runtimeMinutes: data.runtimeMinutes,
          nextAirDate: data.nextAirDate ? new Date(data.nextAirDate) : null,
          seasonsCount: data.seasonsCount,
          episodesCount: data.episodesCount,
          inProduction: data.inProduction,
        },
      });

      await this.syncGenres(tx, mediaId!, genres);
      await this.syncProviders(tx, mediaId!, providers);
      await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, enData?.cast);
      await this.syncSeasons(tx, mediaId!, data.seasons, lang, enData?.seasons);

      return mediaId!;
    });
  }

  private async persistMovie(
    data: NormalizedMovie,
    existingId?: string,
    lang: string = currentLanguage(),
    enData?: NormalizedMovie,
  ): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const prev = existingId
        ? await tx.mediaItem.findUnique({
            where: { id: existingId },
            select: { titles: true, overviews: true, posterUrls: true, backdropUrls: true, titleLocale: true },
          })
        : null;
      const base = enData ?? data;
      const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
      const providers = await this.upsertProviders(tx, data.providers);
      const castMembers = await this.upsertCast(tx, data.cast);

      let titles = mergeLocalized(prev?.titles as any, lang, data.title, enData?.title);
      let overviews = mergeLocalized(prev?.overviews as any, lang, data.overview, enData?.overview);
      // Bulk-store ALL translations from the provider (e.g. TVDB movie meta=translations).
      if (data.translations) {
        for (const [loc, tr] of Object.entries(data.translations)) {
          titles = mergeLocalized(titles as any, loc, tr.title ?? undefined, undefined);
          overviews = mergeLocalized(overviews as any, loc, tr.overview ?? undefined, undefined);
        }
      }

      const mediaData = {
        title: base.title,
        overview: base.overview,
        posterUrl: base.posterUrl,
        backdropUrl: base.backdropUrl,
        rating: data.rating,
        popularity: data.popularity ?? 0,
        trailerUrl: data.trailerUrl,
        metadataRefreshedAt: new Date(),
        titleLocale: enData ? 'en' : (prev?.titleLocale ?? lang),
        titles,
        overviews,
        posterUrls: mergeLocalized(prev?.posterUrls as any, lang, data.posterUrl, enData?.posterUrl),
        backdropUrls: mergeLocalized(prev?.backdropUrls as any, lang, data.backdropUrl, enData?.backdropUrl),
      };

      let mediaId = existingId;
      if (existingId) {
        await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
      } else {
        const created = await tx.mediaItem.create({
          data: {
            ...mediaData,
            type: MediaType.MOVIE,
            externalIds: {
              create: data.externals.map((e) => ({
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: e.value,
              })),
            },
          },
        });
        mediaId = created.id;
      }

      await tx.movie.upsert({
        where: { mediaId: mediaId! },
        create: {
          mediaId: mediaId!,
          releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
          releaseYear: data.releaseYear,
          runtimeMinutes: data.runtimeMinutes,
          country: data.country,
          language: data.language,
        },
        update: {
          releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
          releaseYear: data.releaseYear,
          runtimeMinutes: data.runtimeMinutes,
          country: data.country,
          language: data.language,
        },
      });

      await this.syncGenres(tx, mediaId!, genres);
      await this.syncProviders(tx, mediaId!, providers);
      await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, enData?.cast);

      return mediaId!;
    });
  }

  // ---- Read helpers ----
  private fullShowInclude(userId?: string) {
    return {
      show: { include: { seasons: { include: { episodes: true } } } },
      genres: { include: { genre: true } },
      providers: { include: { provider: true } },
      cast: { include: { castMember: true } },
      externalIds: true,
      ...(userId
        ? {
            watchlist: { where: { userId }, select: { id: true } },
            favorites: { where: { userId }, select: { id: true } },
            showStatuses: { where: { userId }, select: { id: true, watchedCount: true, totalCount: true } },
          }
        : {}),
    } as const;
  }

  async getShowDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: this.fullShowInclude(userId),
    });
    if (!media || !media.show) throw new NotFoundException('Show not found');
    const dto = mapShow(media as any, userId);
    const seasons = (media.show.seasons || [])
      .filter((s) => !s.isSpecial)
      .map((s) => mapSeason(s as any, userId));
    const specials = (media.show.seasons || [])
      .filter((s) => s.isSpecial)
      .map((s) => mapSeason(s as any, userId));

    // Community ratings per episode, grouped by season (for the ratings chart).
    const seasonRatings = await this.computeSeasonRatings(mediaId);

    // Accurate progress from actual watched episodes, excluding specials (season 0) and UNAIRED episodes.
    let userProgress = dto.userProgress ?? 0;
    if (userId) {
      const now = new Date();
      const [watchedEp, totalEp] = await Promise.all([
        this.prisma.userEpisodeStatus.count({
          where: { userId, watched: true, episode: { season: { show: { mediaId }, isSpecial: false } } },
        }),
        this.prisma.episode.count({
          where: {
            season: { show: { mediaId }, isSpecial: false },
            airDate: { not: null, lte: now },
          },
        }),
      ]);
      userProgress = totalEp > 0 ? watchedEp / totalEp : 0;
    }

    return { ...dto, seasons, seasonsWithSpecials: specials, seasonRatings, userProgress };
  }

  private async computeSeasonRatings(mediaId: string) {
    // Source of truth for the chart = YOUR app users' ratings.
    // Unrated episodes count as 0 unless USE_API_FOR_EPISODES_CHART=true (then TMDb fills gaps).
    const useApi = this.config.get<boolean>('metadata.useApiRatingsForChart') === true;
    const eps = await this.prisma.episode.findMany({
      where: { season: { show: { mediaId } } },
      select: {
        number: true,
        rating: true,
        season: { select: { number: true } },
        ratings: { select: { rating: true } },
      },
    });
    const bySeason = new Map<number, { number: number; rating: number; votes: number }[]>();
    for (const e of eps) {
      const votes = e.ratings.length;
      const userAvg = votes ? e.ratings.reduce((a, r) => a + r.rating, 0) / votes : null;
      let value: number;
      if (userAvg != null) {
        value = userAvg; // 1–5 from your users
      } else if (useApi && e.rating) {
        value = e.rating / 2; // TMDb 0–10 scaled to 0–5
      } else {
        value = 0; // no user ratings yet
      }
      const sn = e.season.number;
      if (!bySeason.has(sn)) bySeason.set(sn, []);
      bySeason.get(sn)!.push({ number: e.number, rating: Math.round(value * 10) / 10, votes });
    }
    return [...bySeason.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seasonNumber, episodes]) => ({
        seasonNumber,
        episodes: episodes.sort((a, b) => a.number - b.number),
      }));
  }

  async getShowSeasons(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        show: {
          include: {
            seasons: {
              orderBy: { number: 'asc' },
              include: {
                episodes: {
                  orderBy: { number: 'asc' },
                  ...(userId
                    ? {
                        include: {
                          userStatuses: {
                            where: { userId },
                            select: { watched: true, watchedAt: true, device: true },
                          },
                        },
                      }
                    : {}),
                },
              },
            },
          },
        },
      },
    });
    if (!media?.show) throw new NotFoundException('Show not found');
    return media.show.seasons;
  }

  async getMovieDetail(mediaId: string, userId?: string) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        movie: true,
        genres: { include: { genre: true } },
        providers: { include: { provider: true } },
        cast: { include: { castMember: true } },
        externalIds: true,
        ...(userId
          ? {
              watchlist: { where: { userId }, select: { id: true } },
              favorites: { where: { userId }, select: { id: true } },
              movieStatuses: { where: { userId }, select: { id: true, watched: true, watchedAt: true } },
            }
          : {}),
      },
    });
    if (!media || !media.movie) throw new NotFoundException('Movie not found');
    return mapMovie(media as any, userId);
  }

  // ---- Mapping normalized seasons/episodes ----
  private async syncSeasons(
    tx: PrismaTransaction,
    mediaId: string,
    seasons: NormalizedSeason[],
    lang: string = currentLanguage(),
    enSeasons?: NormalizedSeason[],
  ) {
    const show = await tx.show.findUnique({ where: { mediaId } });
    if (!show) return;
    // Batch-read existing season/episode JSON to merge locale overrides (preserve
    // other locales) in a single query instead of one per season/episode.
    const existingSeasons = await tx.season.findMany({
      where: { showId: show.id },
      select: {
        number: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        episodes: { select: { number: true, titles: true, overviews: true, stillUrls: true } },
      },
    });
    const seasonMap = new Map(existingSeasons.map((s) => [s.number, s]));
    const airedCount = (eps: NormalizedSeason['episodes']) =>
      eps.filter((e) => e.airDate && new Date(e.airDate) <= new Date()).length;
    // Upsert by (showId, number) / (seasonId, number) to PRESERVE user progress across refreshes.
    for (const s of seasons) {
      // Skip empty season shells: no episodes from the provider AND no existing episodes.
      // Prevents broken "0/0 watched" rows when a provider (e.g. TVDB) is rate-limited/empty.
      if ((!s.episodes || s.episodes.length === 0) && (s.episodeCount ?? 0) === 0) {
        const prevSeason = seasonMap.get(s.number);
        if (!prevSeason || (prevSeason.episodes?.length ?? 0) === 0) continue;
      }
      const enS = enSeasons?.find((e) => e.number === s.number);
      const prev = seasonMap.get(s.number);
      const titles = mergeLocalized(prev?.titles as any, lang, s.title, enS?.title);
      const overviews = mergeLocalized(prev?.overviews as any, lang, s.overview, enS?.overview);
      const posterUrls = mergeLocalized(prev?.posterUrls as any, lang, s.posterUrl, enS?.posterUrl);
      const season = await tx.season.upsert({
        where: { showId_number: { showId: show.id, number: s.number } },
        create: {
          showId: show.id,
          number: s.number,
          title: enS?.title ?? s.title,
          overview: enS?.overview ?? s.overview,
          posterUrl: enS?.posterUrl ?? s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: airedCount(s.episodes),
          titles,
          overviews,
          posterUrls,
        },
        update: {
          title: enS?.title ?? s.title,
          overview: enS?.overview ?? s.overview,
          posterUrl: enS?.posterUrl ?? s.posterUrl,
          episodeCount: s.episodeCount,
          isSpecial: s.isSpecial,
          airedCount: airedCount(s.episodes),
          titles,
          overviews,
          posterUrls,
        },
      });
      const epMap = new Map((prev?.episodes ?? []).map((e) => [e.number, e]));
      for (const e of s.episodes) {
        const enE = enS?.episodes.find((ee) => ee.number === e.number);
        const prevEp = epMap.get(e.number);
        const epTitles = mergeLocalized(prevEp?.titles as any, lang, e.title, enE?.title);
        const epOverviews = mergeLocalized(prevEp?.overviews as any, lang, e.overview, enE?.overview);
        const epStillUrls = mergeLocalized(prevEp?.stillUrls as any, lang, e.stillUrl, enE?.stillUrl);
        await tx.episode.upsert({
          where: { seasonId_number: { seasonId: season.id, number: e.number } },
          create: {
            seasonId: season.id,
            number: e.number,
            title: enE?.title ?? e.title,
            overview: enE?.overview ?? e.overview,
            stillUrl: enE?.stillUrl ?? e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
            titles: epTitles,
            overviews: epOverviews,
            stillUrls: epStillUrls,
          },
          update: {
            title: enE?.title ?? e.title,
            overview: enE?.overview ?? e.overview,
            stillUrl: enE?.stillUrl ?? e.stillUrl,
            runtimeMinutes: e.runtimeMinutes,
            airDate: e.airDate ? new Date(e.airDate) : null,
            rating: e.rating,
            isFinale: e.isFinale,
            titles: epTitles,
            overviews: epOverviews,
            stillUrls: epStillUrls,
          },
        });
      }
    }
  }

  async ensureUserShowTotals(userId: string, mediaId: string) {
    const total = await this.prisma.episode.count({
      where: { season: { show: { mediaId }, isSpecial: false } },
    });
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: { userId, mediaId, totalCount: total },
      update: { totalCount: total },
    });
  }

  // ---- Genre / provider / cast dedupe ----
  private async upsertGenres(
    tx: PrismaTransaction,
    genres: { tmdbId?: number; name: string }[],
    lang: string = currentLanguage(),
    enGenres?: { tmdbId?: number; name: string }[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const g of genres) {
      // Match the English name (stable identity) so different request languages
      // collapse onto the same Genre row instead of creating per-language dupes.
      const enName = enGenres?.find((e) => e.tmdbId != null && e.tmdbId === g.tmdbId)?.name;
      const slug = slugify(enName ?? g.name);
      const existing = await tx.genre.findUnique({ where: { slug }, select: { names: true } }).catch(() => null);
      const names = mergeLocalized((existing?.names as any) ?? null, lang, g.name, enName);
      const genre = await tx.genre.upsert({
        where: { slug },
        create: { name: enName ?? g.name, slug, names },
        update: { name: enName ?? g.name, names },
      });
      ids.push(genre.id);
    }
    return ids;
  }

  private async upsertProviders(tx: PrismaTransaction, providers: { name: string; logoUrl?: string | null }[]) {
    const ids: string[] = [];
    for (const p of providers) {
      const provider = await tx.watchProvider.upsert({
        where: { slug: slugify(p.name) },
        create: { name: p.name, slug: slugify(p.name), logoUrl: p.logoUrl },
        update: { logoUrl: p.logoUrl ?? undefined },
      });
      ids.push(provider.id);
    }
    return ids;
  }

  private async upsertCast(tx: PrismaTransaction, cast: { tmdbPersonId: number; name: string; profileUrl?: string | null }[]) {
    const map = new Map<string, { name: string; profileUrl?: string | null }>();
    for (const c of cast) {
      map.set(`TMDB_${c.tmdbPersonId}`, { name: c.name, profileUrl: c.profileUrl });
    }
    const ids: string[] = [];
    for (const [externalId, info] of map) {
      const member = await tx.castMember.upsert({
        where: { externalId },
        create: { externalId, name: info.name, profileUrl: info.profileUrl },
        update: { name: info.name, profileUrl: info.profileUrl ?? undefined },
      });
      ids.push(member.id);
    }
    return ids;
  }

  private async syncGenres(tx: PrismaTransaction, mediaId: string, genreIds: string[]) {
    await tx.mediaGenre.deleteMany({ where: { mediaId } });
    if (genreIds.length > 0) {
      await tx.mediaGenre.createMany({
        data: genreIds.map((genreId) => ({ mediaId, genreId })),
        skipDuplicates: true,
      });
    }
  }

  private async syncProviders(tx: PrismaTransaction, mediaId: string, providerIds: string[]) {
    await tx.mediaWatchProvider.deleteMany({ where: { mediaId } });
    if (providerIds.length > 0) {
      await tx.mediaWatchProvider.createMany({
        data: providerIds.map((providerId) => ({ mediaId, providerId })),
        skipDuplicates: true,
      });
    }
  }

  private async syncCast(
    tx: PrismaTransaction,
    mediaId: string,
    castMemberIds: string[],
    cast: { tmdbPersonId?: number; character?: string | null; order: number }[],
    lang: string = currentLanguage(),
    enCast?: { tmdbPersonId?: number; character?: string | null; order: number }[],
  ) {
    // Preserve other locales' characters: read existing JSON before recreating rows.
    const existing = await tx.mediaCast.findMany({
      where: { mediaId },
      select: { castMemberId: true, characters: true },
    });
    const existingMap = new Map(existing.map((c) => [c.castMemberId, c.characters as any]));
    await tx.mediaCast.deleteMany({ where: { mediaId } });
    for (let i = 0; i < castMemberIds.length; i++) {
      const id = castMemberIds[i];
      const c = cast[i];
      const enChar = enCast?.find((e) => e.tmdbPersonId != null && e.tmdbPersonId === c?.tmdbPersonId)?.character;
      const characters = mergeLocalized(existingMap.get(id) ?? null, lang, c?.character, enChar);
      await tx.mediaCast.create({
        data: {
          mediaId,
          castMemberId: id,
          character: enChar ?? c?.character ?? null,
          characters,
          sortOrder: c?.order ?? i,
        },
      });
    }
  }
}

type PrismaTransaction = Omit<
  PrismaService,
  | '$connect'
  | '$disconnect'
  | '$on'
  | '$transaction'
  | '$use'
  | '$extends'
  | 'onModuleInit'
  | 'onModuleDestroy'
>;
