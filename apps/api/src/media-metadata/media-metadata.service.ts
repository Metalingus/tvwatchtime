import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ExternalProvider,
  MediaType,
  ProviderEntityKind,
  RecommendationDto,
} from '@tvwatch/shared';
import { EpisodeStructureState, Prisma, StructureProvider, StructureReason } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { currentLanguage } from '../common/language.context';
import { mergeLocalized } from '../common/utils/localization.util';
import { mapMovie, mapSeason, mapShow } from '../common/utils/mapper.util';
import {
  NormalizedMovie,
  NormalizedSeason,
  NormalizedShow,
  TmdbProvider,
} from './providers/tmdb.provider';
import {
  TVDB_REMOTE_TYPE_TMDB,
  TvdbProvider,
  type TvdbCharacterRecord,
} from './providers/tvdb.provider';
import { TvmazeProvider } from './providers/tvmaze.provider';
import { HydrationQueue } from './hydration/hydration.queue';
import { ExternalReviewsService } from './external-reviews.service';
import { CastDedupService } from './cast-dedup.service';
import { compatibleAirtimeSeasons } from './util/airtime-structure';
import { slugify } from './util/slugify';
import { EN_CONTENT_VERIFIER_VERSION } from './util/en-content-verifier';
import {
  ShowWriteScope,
  StructureAuthorityService,
  StructureDecision,
} from './structure-authority.service';
import { StructureRemapService } from './structure-remap.service';

/** Metadata is considered stale (eligible for a full refresh) after 24h. */
const DAY_MS = 1000 * 60 * 60 * 24;

/** Compare-and-delete for the media write lock (only the owner releases). */
const MEDIA_LOCK_RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`;

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
    private readonly redis: RedisService,
    private readonly externalReviews?: ExternalReviewsService,
    private readonly castDedup?: CastDedupService,
    @Optional() private readonly structureAuthority?: StructureAuthorityService,
    @Optional() private readonly structureRemap?: StructureRemapService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  /**
   * Serializing per-media write lock (acquire-or-wait, then execute). Hydrations of the
   * same media (detail view vs. tvdb-rehydrate vs. anime cron) used to run their cast /
   * season read-modify-write transactions concurrently, producing duplicate media_cast
   * rows. Unlike ProviderRateLimiter.distinctLock (which skips the waiter's work), every
   * caller here must persist its own payload, so waiters queue and then run.
   */
  private async withMediaWriteLock<T>(
    key: string,
    fn: () => Promise<T>,
    ttlMs = 10 * 60 * 1000,
  ): Promise<T> {
    const client = (this.redis as any)?.client;
    if (!client?.set) return fn(); // Redis unavailable (tests/degraded env) — proceed.
    const lockKey = `LOCK:hydrate:media:${key}`;
    const token = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const acquired =
        (await client.set(lockKey, token, 'PX', ttlMs, 'NX').catch(() => null)) === 'OK';
      if (acquired) {
        try {
          return await fn();
        } finally {
          await client.eval(MEDIA_LOCK_RELEASE, 1, lockKey, token).catch(() => undefined);
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    // Running unlocked would permit a provider refresh to interleave with a remap and
    // recreate the exact dual graph this lock protects. Let the caller retry instead.
    throw new Error(`Timed out waiting for media write lock ${lockKey}`);
  }

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

  private async authorityForTmdb(tmdbId: number, mediaId?: string): Promise<StructureDecision> {
    if (this.structureAuthority) return this.structureAuthority.forTmdb(tmdbId, mediaId);
    return {
      provider: StructureProvider.TMDB,
      reason: StructureReason.GENERAL_TMDB,
      ruleVersion: 1,
      decidedAt: new Date(),
      tmdbId,
    };
  }

  private async authorityForTvdb(tvdbId: number, mediaId?: string): Promise<StructureDecision> {
    if (this.structureAuthority) return this.structureAuthority.forTvdb(tvdbId, mediaId);
    return {
      provider: StructureProvider.TVDB,
      reason: StructureReason.TVDB_ONLY_FALLBACK,
      ruleVersion: 1,
      decidedAt: new Date(),
      tvdbId,
    };
  }

  private async persistedAuthority(mediaId: string): Promise<StructureDecision | null> {
    return this.structureAuthority?.persisted(mediaId) ?? null;
  }

  private async authorityTmdbId(mediaId: string): Promise<number | null> {
    if (this.structureAuthority) return this.structureAuthority.tmdbIdFor(mediaId);
    const ext = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const value = Number(ext?.value);
    return Number.isFinite(value) ? value : null;
  }

  /** Ordinary refreshes may only extend an already-canonical graph. If active rows do
   * not carry the selected owner's episode id, the graph needs the remap workflow so
   * user data is transferred before any second provider structure is written. */
  private async hasActiveProviderMismatch(
    mediaId: string,
    provider: StructureProvider,
  ): Promise<boolean> {
    if (typeof (this.prisma.episode as any)?.count !== 'function') return false;
    const externalProvider =
      provider === StructureProvider.TVDB ? ExternalProvider.THE_TVDB : ExternalProvider.TMDB;
    const count = await this.prisma.episode.count({
      where: {
        structureState: 'ACTIVE',
        season: { show: { mediaId } },
        externalIds: { none: { provider: externalProvider } },
      },
    });
    return count > 0;
  }

  private async attachRoutingExternals(
    mediaId: string,
    decision: StructureDecision,
  ): Promise<void> {
    const values = [
      decision.tmdbId ? { provider: ExternalProvider.TMDB, value: String(decision.tmdbId) } : null,
      decision.tvdbId
        ? { provider: ExternalProvider.THE_TVDB, value: String(decision.tvdbId) }
        : null,
      decision.imdbId ? { provider: ExternalProvider.IMDB, value: decision.imdbId } : null,
    ].filter((value): value is { provider: ExternalProvider; value: string } => !!value);
    for (const value of values) {
      const existing = await this.prisma.externalId.findUnique({
        where: {
          provider_providerEntityKind_value: {
            provider: value.provider,
            providerEntityKind: ProviderEntityKind.SERIES,
            value: value.value,
          },
        },
        select: { mediaId: true },
      });
      if (existing && existing.mediaId !== mediaId) {
        this.logger.warn(
          `routing external ${value.provider}:SERIES:${value.value} is already attached to ${existing.mediaId}; not attaching to ${mediaId}`,
        );
        continue;
      }
      if (!existing) {
        await this.prisma.externalId.create({
          data: {
            mediaId,
            provider: value.provider,
            providerEntityKind: ProviderEntityKind.SERIES,
            value: value.value,
          },
        });
      }
    }
  }

  /** A discovered owner change must hydrate the complete target snapshot and transfer
   * user data under the same media lock. It is never applied as an ordinary refresh. */
  private async remapToDecision(
    mediaId: string,
    decision: StructureDecision,
    userId?: string,
  ): Promise<string> {
    if (!this.structureRemap) {
      this.logger.warn(
        `remapToDecision: remap service unavailable for ${mediaId}; keeping the current structure`,
      );
      return mediaId;
    }
    const target = decision.provider === StructureProvider.TVDB ? 'tvdb' : 'tmdb';
    const providerId = target === 'tvdb' ? decision.tvdbId : decision.tmdbId;
    if (!providerId) {
      this.logger.warn(`remapToDecision: ${mediaId} has no verified ${target.toUpperCase()} id`);
      return mediaId;
    }

    await this.attachRoutingExternals(mediaId, decision);
    return this.withMediaWriteLock(mediaId, async () => {
      if (target === 'tvdb') {
        await this.ensureShowFullTvdb(providerId, userId, {
          decision,
          skipClassification: true,
          writeScope: 'STRUCTURE_REMAP',
          forceRefresh: true,
          lockHeld: true,
        });
      } else {
        await this.ensureShowFull(providerId, userId, {
          decision,
          writeScope: 'STRUCTURE_REMAP',
          forceRefresh: true,
          lockHeld: true,
        });
      }
      const report = await this.structureRemap!.remapShow(mediaId, {
        canonical: target,
        reason: decision.reason,
      });
      // A graph may already carry both aliases on the same canonical rows, leaving no
      // stale row for remapShow to process. The audited workflow still owns the stamp.
      if (report.stale === 0) {
        await this.prisma.show.update({
          where: { mediaId },
          data: {
            structureProvider: decision.provider,
            structureReason: decision.reason,
            structureRuleVersion: decision.ruleVersion,
            structureDecidedAt: decision.decidedAt,
          },
        });
      }
      await this.scheduleClassification(mediaId);
      return mediaId;
    });
  }

  /** Persist a routable anime identity without writing TMDB seasons while its canonical
   * TVDB series id is unavailable. A later routing retry can safely promote this stub. */
  private async persistPendingAnimeProfile(
    decision: StructureDecision,
    existingId?: string,
  ): Promise<string> {
    const profile = decision.profile;
    if (!profile) {
      if (existingId) return existingId;
      throw new NotFoundException('TMDB routing profile is unavailable');
    }
    const mediaId = await this.prisma.$transaction(async (tx) => {
      let id = existingId;
      if (!id) {
        const media = await tx.mediaItem.create({
          data: {
            type: MediaType.SHOW,
            title: profile.title,
            titleLocale: 'en',
            metadataRefreshedAt: null,
            contentClassification: 'ANIME',
            classificationTier: 'confirmed',
            classificationConfidence: 0.95,
            classifiedAt: new Date(),
            classificationEvidence: {
              source: 'TMDB',
              rule: 'animation_genre_and_anime_keyword',
            },
          },
        });
        id = media.id;
      }
      await tx.show.upsert({
        where: { mediaId: id },
        create: {
          mediaId: id,
          yearStart: profile.yearStart,
          keywords: profile.keywords,
          originCountries: [],
          structureProvider: StructureProvider.TVDB,
          structureReason: StructureReason.ANIME_TVDB,
          structureRuleVersion: decision.ruleVersion,
          structureDecidedAt: decision.decidedAt,
        },
        update: {
          keywords: profile.keywords,
          structureProvider: StructureProvider.TVDB,
          structureReason: StructureReason.ANIME_TVDB,
          structureRuleVersion: decision.ruleVersion,
          structureDecidedAt: decision.decidedAt,
        },
      });
      return id;
    });
    await this.attachRoutingExternals(mediaId, decision);
    return mediaId;
  }

  // ---- External lookup ----
  async findMediaByExternal(provider: ExternalProvider, value: string, kind?: ProviderEntityKind) {
    // Kind-aware when requested: TMDB/TVDB use SEPARATE id namespaces per entity type
    // (the same number is a different series vs movie) — hydration must not cross kinds.
    const ext = await this.prisma.externalId.findFirst({
      where: kind ? { provider, providerEntityKind: kind, value } : { provider, value },
      include: { media: true },
    });
    return ext?.media ?? null;
  }

  /** Attach a media external only when it is unclaimed (or already belongs here). */
  private async attachMediaExternal(
    mediaId: string,
    provider: ExternalProvider,
    kind: ProviderEntityKind,
    value: string | null | undefined,
  ): Promise<boolean> {
    const normalized = value?.trim();
    if (!normalized) return false;
    const existing = await this.prisma.externalId.findUnique({
      where: {
        provider_providerEntityKind_value: {
          provider,
          providerEntityKind: kind,
          value: normalized,
        },
      },
      select: { mediaId: true },
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
          where: {
            provider_providerEntityKind_value: {
              provider,
              providerEntityKind: kind,
              value: normalized,
            },
          },
          data: { mediaId },
        });
        this.logger.warn(
          `Repointed verified ${provider}/${kind} id ${normalized} from ${existing.mediaId} to ${mediaId}`,
        );
      }
      return existing.mediaId === mediaId || Boolean(anchoredOwner);
    }
    try {
      await this.prisma.externalId.create({
        data: { mediaId, provider, providerEntityKind: kind, value: normalized },
      });
      return true;
    } catch (e: any) {
      if (e?.code !== 'P2002') throw e;
      const raced = await this.prisma.externalId.findUnique({
        where: {
          provider_providerEntityKind_value: {
            provider,
            providerEntityKind: kind,
            value: normalized,
          },
        },
        select: { mediaId: true },
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
          where: {
            provider_providerEntityKind_value: {
              provider,
              providerEntityKind: kind,
              value: normalized,
            },
          },
          data: { mediaId },
        });
      }
      return Boolean(raced && (raced.mediaId === mediaId || anchoredOwner));
    }
  }

  /**
   * Resolve a TVDB movie through TVDB's verified remote ids. IMDb is also translated
   * through TMDB when TVDB has no direct TMDB id. TMDB's tvdb_id `/find` is deliberately
   * not used here because that namespace does not resolve TVDB movie ids.
   */
  private async resolveTvdbMovieIdentity(item: {
    tvdbId: number;
    tmdbId?: number | null;
    imdbId?: string | null;
  }): Promise<{ tmdbId: number | null; imdbId: string | null }> {
    let tmdbId = item.tmdbId && item.tmdbId > 0 ? item.tmdbId : null;
    let imdbId = item.imdbId?.trim() || null;
    if ((!tmdbId || !imdbId) && this.tvdb.enabled) {
      try {
        const identity = await this.tvdb.getMovieIdentity(item.tvdbId);
        tmdbId ??= identity.tmdbId;
        imdbId ??= identity.imdbId;
      } catch (e) {
        this.logger.debug(
          `TVDB movie identity lookup failed for ${item.tvdbId}: ${(e as Error).message}`,
        );
      }
    }
    if (imdbId && this.tmdb.enabled) {
      try {
        const found = await this.tmdb.findByExternalId(imdbId, 'imdb_id');
        const imdbTmdbId = found?.movie?.tmdbId ?? null;
        if (!tmdbId) {
          tmdbId = imdbTmdbId;
        } else if (imdbTmdbId && imdbTmdbId !== tmdbId) {
          this.logger.warn(
            `TVDB movie ${item.tvdbId} has conflicting remote ids: TMDB ${tmdbId}, IMDb ${imdbId} resolves to TMDB ${imdbTmdbId}; ignoring the IMDb alias`,
          );
          imdbId = null;
        }
      } catch (e) {
        this.logger.debug(`IMDb movie bridge failed for ${imdbId}: ${(e as Error).message}`);
      }
    }
    return { tmdbId, imdbId };
  }

  private async findMovieIdentityOwner(tmdbId: number | null, imdbId: string | null) {
    if (tmdbId) {
      const byTmdb = await this.findMediaByExternal(
        ExternalProvider.TMDB,
        String(tmdbId),
        ProviderEntityKind.MOVIE,
      );
      if (byTmdb?.type === MediaType.MOVIE) return byTmdb;
    }
    if (imdbId) {
      const byImdb = await this.findMediaByExternal(
        ExternalProvider.IMDB,
        imdbId,
        ProviderEntityKind.MOVIE,
      );
      if (byImdb?.type === MediaType.MOVIE) return byImdb;
    }
    return null;
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
      const base =
        type === MediaType.SHOW
          ? await this.tmdb.localizedShowBase(tmdbId, 'en-US')
          : await this.tmdb.localizedMovieBase(tmdbId, 'en-US');
      return base?.title ? base : undefined;
    } catch {
      return undefined;
    }
  }

  /** English TEXT base from TVDB (one translations call) for a new TVDB-origin row —
   *  same "never born stuck in one user's language" contract as fetchEnBase. Returns
   *  undefined unless TVDB actually has an English title (a missing title must NOT
   *  stamp title_locale='en' on a localized base). Best-effort. */
  private async fetchEnBaseTvdb(type: MediaType, tvdbId: number) {
    if (!this.tvdb.enabled) return undefined;
    try {
      const base =
        type === MediaType.SHOW
          ? await this.tvdb.localizedShowBase(tvdbId, 'eng')
          : await this.tvdb.localizedMovieBase(tvdbId, 'eng');
      return base?.title ? base : undefined;
    } catch {
      return undefined;
    }
  }

  /** Localized create fields for a NEW media row: English base (when available) plus
   *  the request-locale override. The base columns hold English so every language
   *  reads correctly via `override[lang] ?? override['en'] ?? base`. */
  private newMediaLocaleFields(
    item: {
      title: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    enBase:
      | {
          title?: string;
          overview?: string | null;
          posterUrl?: string | null;
          backdropUrl?: string | null;
        }
      | undefined,
    lang: string,
    trustRequestLocale = true,
  ) {
    const titleBase = mergeLocalized(null, 'en', enBase?.title, undefined);
    const overviewBase = mergeLocalized(null, 'en', enBase?.overview, undefined);
    const posterBase = mergeLocalized(null, 'en', enBase?.posterUrl, undefined);
    const backdropBase = mergeLocalized(null, 'en', enBase?.backdropUrl, undefined);
    const shouldStoreRequestLocale = trustRequestLocale && (lang !== 'en' || !enBase);
    const title = enBase?.title ?? item.title;
    const overview = enBase?.overview ?? item.overview;
    const titles = shouldStoreRequestLocale
      ? mergeLocalized(titleBase, lang, item.title, undefined)
      : titleBase;
    const overviews = shouldStoreRequestLocale
      ? mergeLocalized(overviewBase, lang, item.overview, undefined)
      : overviewBase;
    return {
      title,
      overview,
      posterUrl: enBase?.posterUrl ?? item.posterUrl,
      backdropUrl: enBase?.backdropUrl ?? item.backdropUrl,
      titleLocale: enBase ? 'en' : trustRequestLocale ? lang : 'und',
      titles,
      overviews,
      posterUrls: shouldStoreRequestLocale
        ? mergeLocalized(posterBase, lang, item.posterUrl, undefined)
        : posterBase,
      backdropUrls: shouldStoreRequestLocale
        ? mergeLocalized(backdropBase, lang, item.backdropUrl, undefined)
        : backdropBase,
      // Birth-stamp for the english-content verifier: the base was JUST read from the
      // provider's English slot, so the verifier would reach the exact same conclusion
      // (provider title == visible title → park) — without this stamp every non-ASCII
      // foreign title (TMDB falls back to the original title when no en translation
      // exists) entered the suspect pool at birth and needed one provider call per row
      // from the nightly cron to leave it, and live search traffic outgrew the drain.
      // The stamp records the values AS STORED so the IS DISTINCT FROM checks match.
      ...(enBase?.title
        ? {
            metadataProvenance: {
              enContentVerifiedTitle: titles.en ?? title,
              enContentVerifiedOverview: overviews.en ?? overview ?? '',
              enContentVerifiedAt: new Date().toISOString(),
              enContentVerifiedVersion: EN_CONTENT_VERIFIER_VERSION,
            },
          }
        : {}),
    };
  }

  // ---- Light upsert for list endpoints ----
  /**
   * Build the locale-override update for an existing media row and report whether
   * anything would actually change. mergeLocalized only ever touches the 'en' and
   * `lang` keys, so comparing those two keys before/after is enough — list
   * refreshes (trending/search/discover) re-send identical values on every call,
   * and skipping the no-op UPDATE halves the write load on those endpoints.
   */
  private localeOverrideUpdate(
    existing: { titles: any; overviews: any; posterUrls: any; backdropUrls: any },
    item: {
      title?: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    lang: string,
    englishBase?: {
      title?: string;
      overview?: string | null;
      posterUrl?: string | null;
      backdropUrl?: string | null;
    },
    opts?: { skipUntrustedEnglish?: boolean },
  ) {
    if (lang === 'en' && !englishBase && opts?.skipUntrustedEnglish) {
      return { data: {}, changed: false };
    }
    const localeItem = lang === 'en' && englishBase ? englishBase : item;
    const data = {
      titles: mergeLocalized(existing.titles as any, lang, localeItem.title, englishBase?.title),
      overviews: mergeLocalized(
        existing.overviews as any,
        lang,
        localeItem.overview,
        englishBase?.overview,
      ),
      posterUrls: mergeLocalized(
        existing.posterUrls as any,
        lang,
        localeItem.posterUrl,
        englishBase?.posterUrl,
      ),
      backdropUrls: mergeLocalized(
        existing.backdropUrls as any,
        lang,
        localeItem.backdropUrl,
        englishBase?.backdropUrl,
      ),
    };
    const same = (before: any, after: any) =>
      (before?.en ?? undefined) === (after?.en ?? undefined) &&
      (before?.[lang] ?? undefined) === (after?.[lang] ?? undefined);
    const changed =
      !same(existing.titles, data.titles) ||
      !same(existing.overviews, data.overviews) ||
      !same(existing.posterUrls, data.posterUrls) ||
      !same(existing.backdropUrls, data.backdropUrls);
    return { data, changed };
  }

  private isProviderSourcedTmdbLightItem(item: {
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    rating?: number | null;
    popularity?: number | null;
  }): boolean {
    return ['overview', 'posterUrl', 'backdropUrl', 'rating', 'popularity'].some((key) =>
      Object.prototype.hasOwnProperty.call(item, key),
    );
  }

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
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.SERIES,
    );
    if (existing) {
      // List data is single-language: store it as a locale override only, never
      // overwriting the (English) base so other users aren't contaminated.
      const trustRequestLocale = lang !== 'en' || this.isProviderSourcedTmdbLightItem(item);
      const enBase = trustRequestLocale
        ? undefined
        : await this.fetchEnBase(MediaType.SHOW, item.tmdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: !trustRequestLocale,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      // Backfill a missing year on stubs created before search mapped the year.
      if (item.year) {
        await this.prisma.show
          .updateMany({
            where: { mediaId: existing.id, yearStart: null },
            data: { yearStart: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBase(MediaType.SHOW, item.tmdbId),
            lang,
            lang !== 'en' || this.isProviderSourcedTmdbLightItem(item),
          ),
          type: MediaType.SHOW,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          show: {
            create: { yearStart: item.year ?? null, inProduction: true },
          },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: tmdbVal,
              },
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      // Race condition: another concurrent call (search/import) created this media first.
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.TMDB,
          tmdbVal,
          ProviderEntityKind.SERIES,
        );
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
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.MOVIE,
    );
    if (existing) {
      const trustRequestLocale = lang !== 'en' || this.isProviderSourcedTmdbLightItem(item);
      const enBase = trustRequestLocale
        ? undefined
        : await this.fetchEnBase(MediaType.MOVIE, item.tmdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: !trustRequestLocale,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.movie
          .updateMany({
            where: { mediaId: existing.id, releaseYear: null },
            data: { releaseYear: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBase(MediaType.MOVIE, item.tmdbId),
            lang,
            lang !== 'en' || this.isProviderSourcedTmdbLightItem(item),
          ),
          type: MediaType.MOVIE,
          rating: item.rating ?? undefined,
          popularity: item.popularity ?? 0,
          movie: { create: { releaseYear: item.year ?? null } },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.TMDB,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: tmdbVal,
              },
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.TMDB,
          tmdbVal,
          ProviderEntityKind.MOVIE,
        );
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
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.SERIES,
    );
    if (existing) {
      const enBase = await this.fetchEnBaseTvdb(MediaType.SHOW, item.tvdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: true,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.show
          .updateMany({
            where: { mediaId: existing.id, yearStart: null },
            data: { yearStart: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }

    // NOTE: NO title-based attach here — a TVDB id is authoritative for identity, a title
    // is not (US vs AU "Married at First Sight" collide; attaching by title poisoned the AU
    // row with the US id and mis-routed every later lookup). Unknown id = a new row, always.
    // The base is English whenever TVDB has an English title (fetched once, light) — the
    // request language lives in the override slots, so the row isn't born contaminated.
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBaseTvdb(MediaType.SHOW, item.tvdbId),
            lang,
            lang !== 'en',
          ),
          type: MediaType.SHOW,
          popularity: item.popularity ?? 0,
          show: { create: { yearStart: item.year ?? null, inProduction: true } },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.THE_TVDB,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: tvdbVal,
              },
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      // Race condition: a concurrent fallback / tvdb-search hydration job created this
      // media first (same check-then-create recovery as the TMDB light upserts).
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.THE_TVDB,
          tvdbVal,
          ProviderEntityKind.SERIES,
        );
        if (found) return found.id;
      }
      throw e;
    }
  }

  /** Light-upsert a movie resolved from TVDB (backup provider). */
  async lightUpsertMovieTvdb(item: {
    tvdbId: number;
    tmdbId?: number | null;
    imdbId?: string | null;
    title: string;
    overview?: string | null;
    posterUrl?: string | null;
    backdropUrl?: string | null;
    popularity?: number | null;
    year?: number | null;
  }): Promise<string> {
    const tvdbVal = String(item.tvdbId);
    const lang = currentLanguage();
    const identity = await this.resolveTvdbMovieIdentity(item);
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.MOVIE,
    );
    if (existing) {
      const owner = await this.findMovieIdentityOwner(identity.tmdbId, identity.imdbId);
      if (owner && owner.id !== existing.id) {
        // A verified remote identity proves this local route is not canonical. An
        // anchored different movie has a poisoned alias, which is safe to repoint.
        // A TVDB-only row may be a real duplicate with user data: keep its alias so the
        // audited merge repair can still select and merge the whole row.
        const existingTmdb = await this.prisma.externalId.findFirst({
          where: {
            mediaId: existing.id,
            provider: ExternalProvider.TMDB,
            providerEntityKind: ProviderEntityKind.MOVIE,
          },
          select: { value: true },
        });
        if (existingTmdb) {
          await this.prisma.externalId.update({
            where: {
              provider_providerEntityKind_value: {
                provider: ExternalProvider.THE_TVDB,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: tvdbVal,
              },
            },
            data: { mediaId: owner.id },
          });
        }
        await this.attachMediaExternal(
          owner.id,
          ExternalProvider.IMDB,
          ProviderEntityKind.MOVIE,
          identity.imdbId,
        );
        this.logger.warn(
          existingTmdb
            ? `Repointed poisoned TVDB movie id ${tvdbVal} from anchored movie ${existing.id} to verified movie ${owner.id}`
            : `TVDB-only movie ${existing.id} duplicates verified movie ${owner.id}; preserving its alias and user data for the audited merge repair`,
        );
        return owner.id;
      }
      if (identity.tmdbId) {
        const attached = await this.attachMediaExternal(
          existing.id,
          ExternalProvider.TMDB,
          ProviderEntityKind.MOVIE,
          String(identity.tmdbId),
        );
        await this.attachMediaExternal(
          existing.id,
          ExternalProvider.IMDB,
          ProviderEntityKind.MOVIE,
          identity.imdbId,
        );
        if (attached) {
          return this.lightUpsertMovie({
            tmdbId: identity.tmdbId,
            title: item.title,
            year: item.year,
          });
        }
      } else {
        await this.attachMediaExternal(
          existing.id,
          ExternalProvider.IMDB,
          ProviderEntityKind.MOVIE,
          identity.imdbId,
        );
      }
      const enBase = await this.fetchEnBaseTvdb(MediaType.MOVIE, item.tvdbId);
      const { data, changed } = this.localeOverrideUpdate(existing, item, lang, enBase, {
        skipUntrustedEnglish: true,
      });
      if (changed) {
        await this.prisma.mediaItem.update({ where: { id: existing.id }, data });
      }
      if (item.year) {
        await this.prisma.movie
          .updateMany({
            where: { mediaId: existing.id, releaseYear: null },
            data: { releaseYear: item.year },
          })
          .catch(() => undefined);
      }
      return existing.id;
    }

    const owner = await this.findMovieIdentityOwner(identity.tmdbId, identity.imdbId);
    if (owner) {
      await this.attachMediaExternal(
        owner.id,
        ExternalProvider.THE_TVDB,
        ProviderEntityKind.MOVIE,
        tvdbVal,
      );
      await this.attachMediaExternal(
        owner.id,
        ExternalProvider.IMDB,
        ProviderEntityKind.MOVIE,
        identity.imdbId,
      );
      return owner.id;
    }

    if (identity.tmdbId) {
      const mediaId = await this.lightUpsertMovie({
        tmdbId: identity.tmdbId,
        title: item.title,
        year: item.year,
      });
      await this.attachMediaExternal(
        mediaId,
        ExternalProvider.THE_TVDB,
        ProviderEntityKind.MOVIE,
        tvdbVal,
      );
      await this.attachMediaExternal(
        mediaId,
        ExternalProvider.IMDB,
        ProviderEntityKind.MOVIE,
        identity.imdbId,
      );
      return mediaId;
    }

    // NOTE: NO title-based attach here — a TVDB id is authoritative for identity, a title
    // is not (US vs AU "Married at First Sight" collide; attaching by title poisoned the AU
    // row with the US id and mis-routed every later lookup). Unknown id = a new row, always.
    // English base when TVDB has one (see the show path above).
    try {
      const created = await this.prisma.mediaItem.create({
        data: {
          ...this.newMediaLocaleFields(
            item,
            await this.fetchEnBaseTvdb(MediaType.MOVIE, item.tvdbId),
            lang,
            lang !== 'en',
          ),
          type: MediaType.MOVIE,
          popularity: item.popularity ?? 0,
          movie: { create: { releaseYear: item.year ?? null } },
          externalIds: {
            create: [
              {
                provider: ExternalProvider.THE_TVDB,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: tvdbVal,
              },
              ...(identity.imdbId
                ? [
                    {
                      provider: ExternalProvider.IMDB,
                      providerEntityKind: ProviderEntityKind.MOVIE,
                      value: identity.imdbId,
                    },
                  ]
                : []),
            ],
          },
        },
      });
      return created.id;
    } catch (e: any) {
      if (e?.code === 'P2002') {
        const found = await this.findMediaByExternal(
          ExternalProvider.THE_TVDB,
          tvdbVal,
          ProviderEntityKind.MOVIE,
        );
        if (found) return found.id;
      }
      throw e;
    }
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
    const missing = rows.filter((m) => !(m.titles as any)?.[lang]);
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
              backdropUrls: mergeLocalized(
                m.backdropUrls as any,
                lang,
                base.backdropUrl,
                undefined,
              ),
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
            show: {
              select: {
                media: { select: { externalIds: { select: { provider: true, value: true } } } },
              },
            },
          },
        },
      },
    });
    const missing = eps.filter((ep) => !(ep.titles as any)?.[lang]);
    const toFetch = missing.slice(0, 100); // bound TMDb calls per request (TMDb paces starts at ~40rps)
    await Promise.all(
      toFetch.map(async (ep) => {
        const tmdb = ep.season.show.media.externalIds.find(
          (e) => e.provider === ExternalProvider.TMDB,
        );
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
    return (
      !existing ||
      !existing.metadataRefreshedAt ||
      Date.now() - existing.metadataRefreshedAt.getTime() > DAY_MS
    );
  }

  /** Locales the provider had NO translation for are parked this long — re-requesting
   *  them on every view just re-fetches the same English fallback. */
  private static readonly LOCALE_UNAVAILABLE_PARK_MS = 7 * DAY_MS;

  /** Parked = we recently confirmed the provider has no translation for `lang` on this row. */
  isLocaleFetchParked(provenance: unknown, lang: string): boolean {
    const at = (provenance as any)?.localeUnavailable?.[lang];
    if (typeof at !== 'string') return false;
    const t = new Date(at).getTime();
    return Number.isFinite(t) && Date.now() - t < MediaMetadataService.LOCALE_UNAVAILABLE_PARK_MS;
  }

  /** Record that the provider has no translation for `lang` (atomic jsonb merge — no
   *  read-modify-write of the whole provenance column). */
  private async stampLocaleUnavailable(mediaId: string, lang: string): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object('localeUnavailable',
                 COALESCE(metadata_provenance->'localeUnavailable', '{}'::jsonb)
                 || jsonb_build_object(${lang}::text, ${new Date().toISOString()}::text))
      WHERE id = ${mediaId}`;
  }

  /** Does the provider's translations map cover `lang`? undefined = the provider gave no
   *  translations payload, so we can't tell (never park on silence). App locales match
   *  exactly, then by their 2-letter base (TMDB keys are ISO 639-1: pt-BR → pt). */
  private translationsCoverLang(
    translations: Record<string, unknown> | undefined,
    lang: string,
  ): boolean | undefined {
    if (!translations) return undefined;
    if (translations[lang]) return true;
    const base = lang.split('-')[0];
    return base !== lang ? !!translations[base] : false;
  }

  /**
   * Fetch + store the request-locale overrides — unless the locale is parked, or the
   * base payload's translations map proves the provider doesn't have it (then park it
   * and skip the call). When only the localized response itself can tell (fresh base),
   * a missing translation is parked WITHOUT storing the provider's English fallback
   * under the locale key.
   */
  private async maybeApplyLocaleOverrides(
    mediaId: string,
    type: MediaType,
    fetchLocalized: () => Promise<NormalizedShow | NormalizedMovie>,
    baseTranslations: Record<string, { title?: string; overview?: string }> | undefined,
    existingProvenance: unknown,
    lang: string,
  ): Promise<void> {
    if (lang === 'en') return;
    if (this.isLocaleFetchParked(existingProvenance, lang)) return;
    const covered = this.translationsCoverLang(baseTranslations, lang);
    if (covered === false) {
      await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      return;
    }
    const data = await fetchLocalized();
    if (covered === undefined && this.translationsCoverLang(data.translations, lang) === false) {
      await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      return;
    }
    await this.applyLocaleOverrides(mediaId, type, data, lang);
  }

  /**
   * Predicate for `TmdbProvider.getShow`: skip the individual season-detail fetch for
   * seasons we already store COMPLETE and fully aired (re-hydrations only — first
   * hydrations fetch everything). A season is skippable when ALL hold:
   *   - not season 0 (specials churn too much),
   *   - stored episodeCount > 0 and equal to the provider's summary episode_count
   *     (any structural change → refetch),
   *   - every stored episode has an airDate and the latest aired > 7 days ago
   *     (post-air correction buffer).
   * Skipped seasons are filtered out of the normalized payload before persistShow, so
   * syncSeasons leaves their rows (airedCount, texts, locale overrides) untouched.
   */
  private async airedSeasonSkipper(
    mediaId: string,
  ): Promise<(seasonNumber: number, providerEpisodeCount: number) => boolean> {
    const seasons = await this.prisma.season.findMany({
      where: { show: { mediaId } },
      select: {
        number: true,
        episodeCount: true,
        episodes: { where: { structureState: 'ACTIVE' }, select: { airDate: true } },
      },
    });
    const byNumber = new Map(seasons.map((s) => [s.number, s]));
    const cutoff = Date.now() - 7 * DAY_MS;
    return (seasonNumber, providerEpisodeCount) => {
      if (seasonNumber === 0) return false;
      const stored = byNumber.get(seasonNumber);
      if (!stored || (stored.episodeCount ?? 0) === 0) return false;
      if (stored.episodeCount !== providerEpisodeCount) return false;
      if (stored.episodes.length === 0) return false;
      let maxAir = 0;
      for (const e of stored.episodes) {
        if (!e.airDate) return false;
        const t = e.airDate.getTime();
        if (t > maxAir) maxAir = t;
      }
      return maxAir < cutoff;
    };
  }

  /** Drop seasons whose detail fetch was skipped (no episodes loaded AND the skipper
   *  covers them) so syncSeasons never upserts a shell over their stored data. */
  private filterSkippedSeasons(
    data: NormalizedShow,
    skip: (seasonNumber: number, providerEpisodeCount: number) => boolean,
  ): void {
    data.seasons = data.seasons.filter(
      (se) => se.episodes.length > 0 || !skip(se.number, se.episodeCount ?? 0),
    );
  }

  async ensureShowFull(
    tmdbId: number,
    userId?: string,
    opts?: {
      skipAiredSeasons?: boolean;
      writeScope?: ShowWriteScope;
      forceRefresh?: boolean;
      decision?: StructureDecision;
      lockHeld?: boolean;
    },
  ): Promise<string> {
    const lang = currentLanguage();
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.SERIES,
    );
    const decision = opts?.decision ?? (await this.authorityForTmdb(tmdbId, existing?.id));
    if (decision.provider === StructureProvider.TVDB && opts?.writeScope !== 'METADATA_ONLY') {
      if (existing) {
        const current = await this.persistedAuthority(existing.id);
        if (current && current.provider !== StructureProvider.TVDB) {
          return this.remapToDecision(existing.id, decision, userId);
        }
      }
      if (!decision.tvdbId) return this.persistPendingAnimeProfile(decision, existing?.id);
      const routedId = await this.ensureShowFullTvdb(decision.tvdbId, userId, {
        decision,
        skipClassification: true,
        writeScope: opts?.writeScope,
        forceRefresh: opts?.forceRefresh,
        lockHeld: opts?.lockHeld,
      });
      await this.attachRoutingExternals(routedId, decision);
      await this.scheduleClassification(routedId);
      return routedId;
    }
    if (
      existing &&
      (opts?.writeScope ?? 'STRUCTURE') === 'STRUCTURE' &&
      (await this.hasActiveProviderMismatch(existing.id, StructureProvider.TMDB))
    ) {
      this.logger.warn(
        `ensureShowFull: ${existing.id} has active non-TMDB episode rows; awaiting explicit structure remap`,
      );
      return existing.id;
    }
    let mediaId: string;
    let externals: { provider: ExternalProvider; value: string }[] = [];
    if (opts?.forceRefresh || this.isStale(existing)) {
      // Interactive detail views skip refetching complete+fully-aired old seasons
      // (latency). Background paths (backfill, repairs, TMDB changes sync) must NOT:
      // their goal is full-structure correctness — e.g. the english-content repair
      // rewrites episode text and the changes sync exists to catch old-season edits.
      const skipSeasonDetail =
        existing && opts?.skipAiredSeasons ? await this.airedSeasonSkipper(existing.id) : undefined;
      const getOpts = skipSeasonDetail ? { skipSeasonDetail } : undefined;
      // ONE English call (appended seasons/keywords/translations): base + episodes stay
      // English; show-level locales come from the translations payload — no second fetch.
      const enData = await this.tmdb.getShow(tmdbId, 'en-US', getOpts);
      if (skipSeasonDetail) this.filterSkippedSeasons(enData, skipSeasonDetail);
      externals = enData.externals;
      mediaId = await this.persistShow(
        enData,
        existing?.id,
        'en',
        undefined,
        ExternalProvider.TMDB,
        opts?.writeScope ?? 'STRUCTURE',
        decision,
        opts?.lockHeld ?? false,
      );
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tmdb.getShow(tmdbId, lang, getOpts);
          externals = data.externals;
          return data;
        },
        enData.translations,
        existing?.metadataProvenance,
        lang,
      );
    } else if (lang !== 'en' && existing) {
      // Fresh trusted base: store ONLY the request-locale override — no base change,
      // no English re-fetch — so different users' languages never contaminate each other.
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tmdb.getShow(tmdbId, lang);
          externals = data.externals;
          return data;
        },
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    // Fill precise air times/dates from TVmaze (best-effort, outside the tx).
    await this.enrichAirtimes(mediaId, externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    // Genres are now persisted → run anime candidate detection (idempotent, deduped).
    await this.scheduleClassification(mediaId);
    return mediaId;
  }

  /**
   * TVDB exposes no public 0–10 rating, so TVDB-hydrated rows are born unrated.
   * When the row ALSO carries a TMDB id, fill the rating with ONE light TMDB base
   * call (vote_average). Best-effort and self-limiting: only runs while the row
   * has no rating. This makes every TVDB-hydration-driven repair (anime rehydrate,
   * character-ids, banner posters, type-mismatch recreation) also heal ratings.
   */
  private async fillRatingFromTmdbIfMissing(mediaId: string, type: MediaType) {
    try {
      const kind = type === MediaType.SHOW ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
      const media = await this.prisma.mediaItem.findUnique({
        where: { id: mediaId },
        select: {
          rating: true,
          externalIds: {
            where: { provider: ExternalProvider.TMDB, providerEntityKind: kind },
            select: { value: true },
            take: 1,
          },
        },
      });
      if (!media || media.rating != null || !this.tmdb.enabled) return;
      const tmdbIdRaw = media.externalIds[0]?.value;
      if (!tmdbIdRaw) return;
      const base =
        type === MediaType.SHOW
          ? await this.tmdb.localizedShowBase(Number(tmdbIdRaw), 'en-US')
          : await this.tmdb.localizedMovieBase(Number(tmdbIdRaw), 'en-US');
      if (base.rating != null && base.rating > 0) {
        await this.prisma.mediaItem.update({
          where: { id: mediaId },
          data: { rating: base.rating },
        });
      }
    } catch (e) {
      this.logger.debug(`rating fill skipped for ${mediaId}: ${(e as Error).message}`);
    }
  }

  private async pendingTvdbCharacterIds(mediaId: string): Promise<number[]> {
    const rows = await this.prisma.$queryRaw<{ characterId: number }[]>`
      SELECT DISTINCT (ii.normalized_data->>'showCharacterId')::int AS "characterId"
      FROM import_items ii
      WHERE ii.matched_media_id=${mediaId}
        AND ii.source_entity_type IN ('EPISODE_CHARACTER_VOTE', 'MOVIE_CHARACTER_VOTE')
        AND ii.status IN ('MATCHED', 'PENDING_MATCH')
        AND COALESCE(ii.normalized_data->>'showCharacterId', '') ~ '^[1-9][0-9]*$'`;
    return rows
      .map((row) => Number(row.characterId))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  }

  /**
   * Resolve pending TV Time role ids against a TMDB-canonical movie without replacing
   * any movie metadata. Provider reads are deduplicated and bounded; persistence only
   * adds verified role aliases (and, for a directly verified TVDB movie role, a protected
   * supplemental cast row when the normal TMDB cast lacks that person).
   */
  async enrichMovieCastForPendingVotes(
    mediaId: string,
  ): Promise<{ requested: number; resolved: number }> {
    const media = await this.prisma.mediaItem.findFirst({
      where: { id: mediaId, type: MediaType.MOVIE },
      include: { externalIds: true },
    });
    if (!media) throw new NotFoundException('Movie not found');
    const targetTmdbId = Number(
      media.externalIds.find(
        (id) =>
          id.provider === ExternalProvider.TMDB &&
          id.providerEntityKind === ProviderEntityKind.MOVIE,
      )?.value,
    );
    if (!Number.isSafeInteger(targetTmdbId) || targetTmdbId <= 0) {
      throw new Error(`Movie ${mediaId} has no canonical TMDB identity`);
    }

    const requiredIds = await this.pendingTvdbCharacterIds(mediaId);
    if (!requiredIds.length) {
      await this.events?.emitAsync('metadata.cast-refreshed', { mediaId });
      return { requested: 0, resolved: 0 };
    }
    const existingAliases = await this.prisma.mediaCastExternalId.findMany({
      where: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        value: { in: requiredIds.map(String) },
      },
      select: { value: true },
    });
    const alreadyResolved = new Set(existingAliases.map((alias) => alias.value));
    const pendingIds = requiredIds.filter((id) => !alreadyResolved.has(String(id)));

    const roleResults = new Map<number, TvdbCharacterRecord>();
    for (let offset = 0; offset < pendingIds.length; offset += 4) {
      const chunk = pendingIds.slice(offset, offset + 4);
      const records = await Promise.all(chunk.map((id) => this.tvdb.getCharacter(id)));
      records.forEach((record, index) => {
        if (record) roleResults.set(chunk[index], record);
      });
    }

    const personCache = new Map<number, Awaited<ReturnType<TvdbProvider['getPersonExtended']>>>();
    const movieIdentityCache = new Map<
      number,
      Awaited<ReturnType<TvdbProvider['getMovieIdentity']>>
    >();
    const evidence: Array<{
      roleId: number;
      role: TvdbCharacterRecord;
      movieProven: boolean;
      personKeys: string[];
    }> = [];
    const verifiedTvdbMovieIds = new Set<number>();
    const normalizeRole = (value?: string | null) =>
      String(value ?? '')
        .normalize('NFKD')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
    const roleCompatible = (left?: string | null, right?: string | null) => {
      const a = normalizeRole(left);
      const b = normalizeRole(right);
      return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
    };

    for (const [roleId, role] of roleResults) {
      let movieProven = false;
      if (role.movieId) {
        let identity = movieIdentityCache.get(role.movieId);
        if (!identity) {
          identity = await this.tvdb.getMovieIdentity(role.movieId);
          movieIdentityCache.set(role.movieId, identity);
        }
        movieProven = identity.tmdbId === targetTmdbId;
        if (movieProven) verifiedTvdbMovieIds.add(role.movieId);
      }

      const personKeys: string[] = [];
      let person: Awaited<ReturnType<TvdbProvider['getPersonExtended']>> | undefined;
      if (role.peopleId) {
        personKeys.push(`TVDB_${role.peopleId}`);
        person = personCache.get(role.peopleId);
        if (person === undefined) {
          person = await this.tvdb.getPersonExtended(role.peopleId);
          personCache.set(role.peopleId, person);
        }
        const tmdbPersonId = person?.remoteIds?.find(
          (remote) =>
            remote.type === TVDB_REMOTE_TYPE_TMDB ||
            /themoviedb|tmdb/i.test(remote.sourceName ?? ''),
        )?.id;
        if (tmdbPersonId && /^\d+$/.test(tmdbPersonId)) {
          personKeys.unshift(`TMDB_${tmdbPersonId}`);
        }
      }
      // Series-scoped synthetic roles can still be proven against a movie when the same
      // TVDB person has a compatible role on a TVDB movie whose remote TMDB id is exactly
      // this canonical movie. Bound the identity probes so large filmographies stay cheap.
      if (!movieProven && person?.characters?.length) {
        const candidateMovieIds = [
          ...new Set(
            person.characters
              .filter((character) => character.movieId && roleCompatible(character.name, role.name))
              .map((character) => character.movieId!),
          ),
        ].slice(0, 5);
        for (const movieId of candidateMovieIds) {
          let identity = movieIdentityCache.get(movieId);
          if (!identity) {
            identity = await this.tvdb.getMovieIdentity(movieId);
            movieIdentityCache.set(movieId, identity);
          }
          if (identity.tmdbId === targetTmdbId) {
            movieProven = true;
            verifiedTvdbMovieIds.add(movieId);
            break;
          }
        }
      }
      evidence.push({ roleId, role, movieProven, personKeys: [...new Set(personKeys)] });
    }

    let resolved = alreadyResolved.size;
    await this.prisma.$transaction(async (tx) => {
      for (const tvdbMovieId of verifiedTvdbMovieIds) {
        const owner = await tx.externalId.findUnique({
          where: {
            provider_providerEntityKind_value: {
              provider: ExternalProvider.THE_TVDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: String(tvdbMovieId),
            },
          },
          select: { mediaId: true },
        });
        if (!owner) {
          await tx.externalId.create({
            data: {
              mediaId,
              provider: ExternalProvider.THE_TVDB,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: String(tvdbMovieId),
            },
          });
        }
      }

      const lastCast = await tx.mediaCast.findFirst({
        where: { mediaId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      let supplementalOrder = (lastCast?.sortOrder ?? -1) + 1;

      for (const item of evidence) {
        const candidates = item.personKeys.length
          ? await tx.mediaCast.findMany({
              where: {
                mediaId,
                castMember: { externalId: { in: item.personKeys } },
              },
              include: { castMember: true },
            })
          : [];
        let cast = candidates.find((candidate) =>
          roleCompatible(candidate.character, item.role.name),
        );
        if (!cast && item.movieProven) cast = candidates[0];

        if (!cast && item.movieProven && item.personKeys.length) {
          const externalId = item.personKeys[0];
          const member = await tx.castMember.upsert({
            where: { externalId },
            create: {
              externalId,
              name: item.role.personName?.trim() || 'Unknown',
              profileUrl: item.role.personImgURL ?? item.role.image ?? null,
            },
            // Do not let a supplemental TVDB role rewrite a shared canonical person row.
            update: {},
          });
          cast = await tx.mediaCast.upsert({
            where: { mediaId_castMemberId: { mediaId, castMemberId: member.id } },
            create: {
              mediaId,
              castMemberId: member.id,
              character: item.role.name ?? null,
              sortOrder: supplementalOrder++,
              characterExternalId: item.roleId,
            },
            update: {},
            include: { castMember: true },
          });
        }
        if (!cast) continue;

        await tx.mediaCastExternalId.upsert({
          where: {
            mediaId_provider_value: {
              mediaId,
              provider: ExternalProvider.THE_TVDB,
              value: String(item.roleId),
            },
          },
          create: {
            mediaId,
            castId: cast.id,
            provider: ExternalProvider.THE_TVDB,
            value: String(item.roleId),
          },
          update: { castId: cast.id },
        });
        resolved++;
      }
    });

    await this.events?.emitAsync('metadata.cast-refreshed', { mediaId });
    return { requested: requiredIds.length, resolved };
  }

  async ensureShowFullTvdb(
    tvdbId: number,
    userId?: string,
    opts?: {
      skipClassification?: boolean;
      writeScope?: ShowWriteScope;
      forceRefresh?: boolean;
      decision?: StructureDecision;
      lockHeld?: boolean;
    },
  ): Promise<string> {
    const lang = currentLanguage();
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.SERIES,
    );
    const decision = opts?.decision ?? (await this.authorityForTvdb(tvdbId, existing?.id));
    if (decision.provider === StructureProvider.TMDB && opts?.writeScope !== 'CAST_ONLY') {
      const tmdbId = decision.tmdbId ?? (existing ? await this.authorityTmdbId(existing.id) : null);
      if (tmdbId && existing) {
        const current = await this.persistedAuthority(existing.id);
        if (current && current.provider !== StructureProvider.TMDB) {
          return this.remapToDecision(existing.id, { ...decision, tmdbId }, userId);
        }
      }
      if (tmdbId) return this.ensureShowFull(tmdbId, userId);
      if (existing) return existing.id;
    }
    if (
      existing &&
      (opts?.writeScope ?? 'STRUCTURE') === 'STRUCTURE' &&
      (await this.hasActiveProviderMismatch(existing.id, StructureProvider.TVDB))
    ) {
      this.logger.warn(
        `ensureShowFullTvdb: ${existing.id} has active non-TVDB episode rows; awaiting explicit structure remap`,
      );
      return existing.id;
    }
    let mediaId: string;
    let externals: { provider: ExternalProvider; value: string }[] = [];
    const castOnly = opts?.writeScope === 'CAST_ONLY';
    const requiredCharacterIds =
      castOnly && existing ? await this.pendingTvdbCharacterIds(existing.id) : [];
    const fetchOpts = castOnly ? { includeStructure: false, requiredCharacterIds } : undefined;
    if (opts?.forceRefresh || this.isStale(existing)) {
      const data = await this.tvdb.getShow(tvdbId, lang, fetchOpts); // pass locale → episodes get correct language
      externals = data.externals;
      const enData = lang !== 'en' ? await this.tvdb.getShow(tvdbId, 'en', fetchOpts) : undefined;
      mediaId = await this.persistShow(
        data,
        existing?.id,
        lang,
        enData,
        ExternalProvider.THE_TVDB,
        opts?.writeScope ?? 'STRUCTURE',
        decision,
        opts?.lockHeld ?? false,
      );
      // TVDB lacks this locale entirely → park it so fresh views skip the re-fetch.
      if (lang !== 'en' && this.translationsCoverLang(data.translations, lang) === false) {
        await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      }
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.SHOW,
        async () => {
          const data = await this.tvdb.getShow(tvdbId, lang);
          externals = data.externals;
          return data;
        },
        undefined,
        existing.metadataProvenance,
        lang,
      );
    } else {
      mediaId = existing!.id;
    }
    if (userId) {
      await this.ensureUserShowTotals(userId, mediaId);
    }
    await this.enrichAirtimes(mediaId, externals).catch((e) =>
      this.logger.debug(`TVmaze enrich skipped: ${(e as Error).message}`),
    );
    // Cast-only rehydrations (character-id backfill, import tvdb-rehydrate) skip the
    // classification enqueue — the anime evidence (genres/origin/keywords) does not
    // change from a same-provider cast refresh, and the enqueue storm saturates Jikan.
    if (!opts?.skipClassification) await this.scheduleClassification(mediaId);
    await this.fillRatingFromTmdbIfMissing(mediaId, MediaType.SHOW);
    return mediaId;
  }

  /** Fully hydrate a movie resolved from TVDB. ONE call — meta=translations returns ALL locales. */
  async ensureMovieFullTvdb(tvdbId: number): Promise<string> {
    const lang = currentLanguage();
    const tvdbVal = String(tvdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.THE_TVDB,
      tvdbVal,
      ProviderEntityKind.MOVIE,
    );
    let prefetched: NormalizedMovie | undefined;
    let routedId: string;
    if (!existing) {
      prefetched = await this.tvdb.getMovie(tvdbId, lang);
      const remoteTmdb = prefetched.externals.find(
        (e) => e.provider === ExternalProvider.TMDB,
      )?.value;
      const remoteImdb = prefetched.externals.find(
        (e) => e.provider === ExternalProvider.IMDB,
      )?.value;
      // A true TVDB-only movie can be persisted directly. When remote ids exist, route
      // through the canonical light-upsert first so an existing TMDB/IMDb row is reused.
      if (!remoteTmdb && !remoteImdb) {
        const mediaId = await this.persistMovie(
          prefetched,
          undefined,
          lang,
          undefined,
          ExternalProvider.THE_TVDB,
        );
        if (lang !== 'en' && this.translationsCoverLang(prefetched.translations, lang) === false) {
          await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
        }
        await this.scheduleClassification(mediaId);
        await this.fillRatingFromTmdbIfMissing(mediaId, MediaType.MOVIE);
        return mediaId;
      }
      const parsedTmdb = remoteTmdb ? Number(remoteTmdb) : NaN;
      routedId = await this.lightUpsertMovieTvdb({
        tvdbId,
        tmdbId: Number.isSafeInteger(parsedTmdb) && parsedTmdb > 0 ? parsedTmdb : null,
        imdbId: remoteImdb ?? null,
        title: prefetched.title,
        overview: prefetched.overview,
        posterUrl: prefetched.posterUrl,
        backdropUrl: prefetched.backdropUrl,
        popularity: prefetched.popularity,
        year: prefetched.releaseYear,
      });
    } else {
      routedId = await this.lightUpsertMovieTvdb({
        tvdbId,
        title: existing.title,
        year: null,
      });
    }
    const tmdb = await this.prisma.externalId.findFirst({
      where: {
        mediaId: routedId,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.MOVIE,
      },
      select: { value: true },
    });
    if (tmdb && Number.isSafeInteger(Number(tmdb.value))) {
      return this.ensureMovieFull(Number(tmdb.value));
    }
    const routed =
      routedId === existing?.id
        ? existing
        : await this.prisma.mediaItem.findUnique({ where: { id: routedId } });
    let mediaId: string;
    if (this.isStale(routed)) {
      const data = prefetched ?? (await this.tvdb.getMovie(tvdbId, lang));
      // No second call needed: data.translations already has ALL locales (including English).
      // persistMovie bulk-stores them all via mergeLocalized.
      mediaId = await this.persistMovie(data, routedId, lang, undefined, ExternalProvider.THE_TVDB);
      // TVDB lacks this locale entirely → park it so fresh views skip the re-fetch.
      if (lang !== 'en' && this.translationsCoverLang(data.translations, lang) === false) {
        await this.stampLocaleUnavailable(mediaId, lang).catch(() => undefined);
      }
    } else if (lang !== 'en' && routed) {
      mediaId = routed.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tvdb.getMovie(tvdbId, lang),
        undefined,
        routed.metadataProvenance,
        lang,
      );
    } else {
      mediaId = routedId;
    }
    await this.scheduleClassification(mediaId);
    await this.fillRatingFromTmdbIfMissing(mediaId, MediaType.MOVIE);
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
    await this.prisma.$transaction(
      async (tx) => {
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
              backdropUrls: mergeLocalized(
                media.backdropUrls as any,
                lang,
                data.backdropUrl,
                undefined,
              ),
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
            episodes: {
              select: { id: true, number: true, titles: true, overviews: true, stillUrls: true },
            },
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
      },
      { timeout: 60_000 },
    );
  }

  private async enrichAirtimes(
    mediaId: string,
    externals: { provider: ExternalProvider; value: string }[],
  ) {
    if (!this.tvmaze.enabled) return;
    const tvdb = externals.find((e) => e.provider === ExternalProvider.THE_TVDB)?.value;
    const imdb = externals.find((e) => e.provider === ExternalProvider.IMDB)?.value;
    if (!tvdb && !imdb) return;
    // Shared by scheduled refresh, show-detail reads, and full show hydrations/repairs.
    // TVmaze doesn't cover every show and rate-limits aggressively, so every path gets
    // the same per-show cooldown instead of hydration jobs bypassing it.
    const marker = `airtimes:tried:${mediaId}`;
    if (await this.redis.get(marker)) return;
    await this.redis.set(marker, 1, 6 * 3600);
    const map = await this.tvmaze.getEpisodeAirTimes(tvdb, imdb);
    if (map.size === 0) return;
    const eps = await this.prisma.episode.findMany({
      where: { structureState: 'ACTIVE', season: { show: { mediaId } } },
      select: { id: true, number: true, season: { select: { number: true } } },
    });
    const compatibleSeasons = compatibleAirtimeSeasons(map.keys(), eps);
    const incompatibleSeasons = [
      ...new Set(
        eps
          .map((episode) => episode.season.number)
          .filter((seasonNumber) => !compatibleSeasons.has(seasonNumber)),
      ),
    ];
    if (incompatibleSeasons.length > 0) {
      await this.prisma.episode.updateMany({
        where: {
          structureState: 'ACTIVE',
          airTime: { not: null },
          season: { show: { mediaId }, number: { in: incompatibleSeasons } },
        },
        data: { airTime: null },
      });
    }
    if (compatibleSeasons.size === 0) return;
    // One UPDATE ... FROM (VALUES ...) for the whole show — the old loop issued one
    // serial UPDATE per episode (500+ round trips on long-running shows).
    const updates: { id: string; airTime: string | null; airDate: Date | null }[] = [];
    for (const e of eps) {
      if (!compatibleSeasons.has(e.season.number)) continue;
      const air = map.get(`${e.season.number}-${e.number}`);
      if (!air) continue;
      updates.push({
        id: e.id,
        airTime: air.airtime ?? null,
        airDate: air.airstamp ? new Date(air.airstamp) : null,
      });
    }
    if (!updates.length) return;
    const values = updates.map((u) => Prisma.sql`(${u.id}, ${u.airTime}, ${u.airDate})`);
    await this.prisma.$executeRaw`
      UPDATE episodes e
      SET air_time = v.air_time,
          air_date = COALESCE(v.air_date::timestamptz, e.air_date)
      FROM (VALUES ${Prisma.join(values)}) AS v(id, air_time, air_date)
      WHERE e.id = v.id
    `;
  }

  /** Populate per-episode air times from TVmaze if any are missing (idempotent / cached). */
  async ensureAirtimes(mediaId: string) {
    if (!this.tvmaze.enabled) return;
    const missing = await this.prisma.episode.count({
      where: { structureState: 'ACTIVE', season: { show: { mediaId } }, airTime: null },
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
    const tmdbVal = String(tmdbId);
    const existing = await this.findMediaByExternal(
      ExternalProvider.TMDB,
      tmdbVal,
      ProviderEntityKind.MOVIE,
    );
    let mediaId: string;
    if (this.isStale(existing)) {
      // ONE English call — base + all show-level locales via the translations payload.
      const data = await this.tmdb.getMovie(tmdbId, 'en-US');
      mediaId = await this.persistMovie(data, existing?.id, 'en', undefined);
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tmdb.getMovie(tmdbId, lang),
        data.translations,
        existing?.metadataProvenance,
        lang,
      );
    } else if (lang !== 'en' && existing) {
      mediaId = existing.id;
      await this.maybeApplyLocaleOverrides(
        mediaId,
        MediaType.MOVIE,
        () => this.tmdb.getMovie(tmdbId, lang),
        undefined,
        existing.metadataProvenance,
        lang,
      );
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
    // Provider of the episode ids carried in `data.seasons[].episodes[].tmdbId`
    // (TMDB id for TMDB hydration; TVDB id smuggled into the same field for TVDB hydration).
    episodeExternalProvider: ExternalProvider = ExternalProvider.TMDB,
    writeScope: ShowWriteScope = 'STRUCTURE',
    requestedDecision?: StructureDecision,
    lockHeld = false,
  ): Promise<string> {
    // Serialize concurrent hydrations of the same media (see withMediaWriteLock).
    const lockKey = existingId ?? `${episodeExternalProvider}:show:${data.tvdbId ?? data.tmdbId}`;
    const sourceDecision =
      requestedDecision ??
      (episodeExternalProvider === ExternalProvider.THE_TVDB
        ? await this.authorityForTvdb(data.tvdbId ?? data.tmdbId, existingId)
        : await this.authorityForTmdb(data.tmdbId, existingId));
    // Existing ownership is sticky. A differing new decision is a repair request, not
    // permission to union a second provider's episode graph onto the row.
    const persisted = existingId ? await this.persistedAuthority(existingId) : null;
    const effectiveDecision =
      writeScope === 'STRUCTURE_REMAP' ? sourceDecision : (persisted ?? sourceDecision);
    const persist = () =>
      this.persistShowLocked(
        data,
        existingId,
        lang,
        enData,
        episodeExternalProvider,
        writeScope,
        effectiveDecision,
      );
    return lockHeld ? persist() : this.withMediaWriteLock(lockKey, persist);
  }

  private async persistShowLocked(
    data: NormalizedShow,
    existingId: string | undefined,
    lang: string,
    enData: NormalizedShow | undefined,
    episodeExternalProvider: ExternalProvider,
    writeScope: ShowWriteScope,
    structureDecision: StructureDecision,
  ): Promise<string> {
    const sourceProvider =
      episodeExternalProvider === ExternalProvider.THE_TVDB
        ? StructureProvider.TVDB
        : StructureProvider.TMDB;
    // 60s timeout (default 5s): this tx now carries only show-level writes (media,
    // genres, providers, cast, stamp) — seasons persist per-season afterwards
    // (see syncSeasons), so the timeout is generous headroom, not a hard cliff.
    const mediaId = await this.prisma.$transaction(
      async (tx) => {
        // Existing JSON (to merge locale overrides without clobbering other locales).
        let prev = existingId
          ? await tx.mediaItem.findUnique({
              where: { id: existingId },
              select: {
                titles: true,
                overviews: true,
                posterUrls: true,
                backdropUrls: true,
                type: true,
              },
            })
          : null;
        // Cross-type guard: series data must NEVER merge into a MOVIE row (TMDB/TVDB use
        // separate movie/series id namespaces — a shared number is a different entity).
        if (prev && prev.type !== MediaType.SHOW) {
          this.logger.warn(
            `persistShow: refusing to merge series into ${prev.type} row ${existingId} — creating a new show row`,
          );
          existingId = undefined;
          prev = null;
        }
        if (writeScope === 'METADATA_ONLY' && existingId) {
          const providers = await this.upsertProviders(tx, data.providers);
          await tx.mediaItem.update({
            where: { id: existingId },
            data: {
              ...(data.recommendations
                ? {
                    recommendations: data.recommendations as any,
                    recommendationsSyncedAt: new Date(),
                  }
                : {}),
              ...(data.providersByCountry
                ? { watchProviders: data.providersByCountry as any }
                : {}),
            },
          });
          if (episodeExternalProvider === ExternalProvider.TMDB) {
            await this.syncProviders(tx, existingId, providers);
          }
          return existingId;
        }
        if (writeScope === 'ARTWORK_ONLY' && existingId) {
          if (sourceProvider !== structureDecision.provider) {
            this.logger.warn(
              `persistShow: blocked non-owner ${sourceProvider} artwork write for ${existingId}`,
            );
            return existingId;
          }
          await tx.mediaItem.update({
            where: { id: existingId },
            data: {
              posterUrl: (enData ?? data).posterUrl,
              backdropUrl: (enData ?? data).backdropUrl,
              posterUrls: mergeLocalized(
                prev?.posterUrls as any,
                lang,
                data.posterUrl,
                enData?.posterUrl,
              ),
              backdropUrls: mergeLocalized(
                prev?.backdropUrls as any,
                lang,
                data.backdropUrl,
                enData?.backdropUrl,
              ),
            },
          });
          return existingId;
        }
        const base = enData ?? data; // English base when available, else the fetched locale
        const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
        const providers = await this.upsertProviders(tx, data.providers);
        const castMembers = await this.upsertCast(tx, data.cast);

        if (writeScope === 'CAST_ONLY' && existingId) {
          await this.syncCast(tx, existingId, castMembers, data.cast, lang, enData?.cast);
          return existingId;
        }

        let titles = mergeLocalized(prev?.titles as any, lang, data.title, enData?.title);
        let overviews = mergeLocalized(
          prev?.overviews as any,
          lang,
          data.overview,
          enData?.overview,
        );
        // Bulk-store every locale from the appended translations payload as overrides, so a
        // later view in another language never forces a full re-hydration.
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
          status: data.status,
          popularity: data.popularity ?? 0,
          trailerUrl: data.trailerUrl,
          metadataRefreshedAt: new Date(),
          // The marker describes the base JUST WRITTEN (base = enData ?? data in `lang`).
          // Never inherit prev.titleLocale — a stale non-en marker would survive an
          // English re-hydration and the row would stay "non-English base" forever.
          titleLocale: enData ? 'en' : lang,
          titles,
          overviews,
          posterUrls: mergeLocalized(
            prev?.posterUrls as any,
            lang,
            data.posterUrl,
            enData?.posterUrl,
          ),
          backdropUrls: mergeLocalized(
            prev?.backdropUrls as any,
            lang,
            data.backdropUrl,
            enData?.backdropUrl,
          ),
          // TVDB supplies no recommendations — never clobber the TMDB snapshot.
          ...(data.recommendations
            ? { recommendations: data.recommendations as any, recommendationsSyncedAt: new Date() }
            : {}),
          // TVDB supplies no watch offers — never clobber the TMDB per-country blob.
          ...(data.providersByCountry ? { watchProviders: data.providersByCountry as any } : {}),
        };

        let mediaId = existingId;
        if (existingId) {
          await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
        } else {
          const created = await tx.mediaItem.create({
            data: {
              ...mediaData,
              type: MediaType.SHOW,
              // Externals attach via the conflict-safe upsert loop below — a parked id on
              // another row must never abort the whole hydration with a P2002.
            },
          });
          mediaId = created.id;
        }

        // upsert externals (in case new ones appeared)
        for (const e of data.externals) {
          await tx.externalId.upsert({
            where: {
              provider_providerEntityKind_value: {
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.SERIES,
                value: e.value,
              },
            },
            create: {
              mediaId: mediaId!,
              provider: e.provider,
              providerEntityKind: ProviderEntityKind.SERIES,
              value: e.value,
            },
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
            originalLanguage: data.originalLanguage ?? null,
            originalTitle: data.originalTitle ?? null,
            originCountries: data.originCountries ?? [],
            keywords: (data.keywords as any) ?? undefined,
            structureProvider: structureDecision.provider,
            structureReason: structureDecision.reason,
            structureRuleVersion: structureDecision.ruleVersion,
            structureDecidedAt: structureDecision.decidedAt,
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
            // Only TMDB supplies origin evidence — preserve existing values on TVDB refreshes.
            ...(data.originalLanguage !== undefined
              ? { originalLanguage: data.originalLanguage }
              : {}),
            ...(data.originalTitle !== undefined ? { originalTitle: data.originalTitle } : {}),
            ...(data.originCountries !== undefined
              ? { originCountries: data.originCountries }
              : {}),
            // TVDB supplies no keywords — never clobber TMDB-persisted ones.
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
        });

        // Update rule metadata only while ownership is unchanged. Provider changes are
        // stamped by the remap workflow after all user data has been transferred.
        if (typeof (tx.show as any).updateMany === 'function') {
          await tx.show.updateMany({
            where: {
              mediaId: mediaId!,
              structureProvider: structureDecision.provider,
              structureReason: { not: StructureReason.MANUAL_OVERRIDE },
            },
            data: {
              structureReason: structureDecision.reason,
              structureRuleVersion: structureDecision.ruleVersion,
              structureDecidedAt: structureDecision.decidedAt,
            },
          });
        }

        await this.syncGenres(tx, mediaId!, genres);
        // TVDB supplies no watch offers (empty array) — syncing from it would WIPE the
        // TMDB-persisted provider links. Only TMDB hydration is authoritative for offers.
        if (episodeExternalProvider === ExternalProvider.TMDB) {
          await this.syncProviders(tx, mediaId!, providers);
        }
        await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, enData?.cast);

        // Record which provider owns this show's season/episode structure — set once
        // (first full hydration) and only upgraded by the anime TVDB repair, so refresh
        // routing (hydrateOne) is deterministic instead of inferring ownership from the
        // mere presence of a TVDB cross-id. (Guarded: raw SQL only — some test harnesses
        // mock a reduced transaction surface.)
        if (typeof (tx as any).$executeRaw === 'function') {
          const structureProvider =
            structureDecision.provider === StructureProvider.TVDB ? 'tvdb' : 'tmdb';
          await tx.$executeRaw`
          UPDATE media_items
          SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
                || jsonb_build_object('structureProvider', ${structureProvider}::text)
          WHERE id = ${mediaId!}
            AND metadata_provenance->>'structureProvider' IS NULL`;
        }

        return mediaId!;
      },
      { timeout: 60_000 },
    );
    if (writeScope === 'CAST_ONLY') {
      await this.events
        ?.emitAsync('metadata.cast-refreshed', { mediaId })
        .catch((e) =>
          this.logger.warn(
            `Cast refreshed for ${mediaId}, but pending vote replay was deferred: ${(e as Error).message}`,
          ),
        );
    }
    // Seasons persist OUTSIDE the core transaction — one transaction per season
    // (see syncSeasons). Mega-dailies (10k+ episodes) otherwise built a single
    // ~30k-statement transaction that blew the 60s timeout and silently rolled
    // back the ENTIRE hydration, and the whole existing episode graph (fat
    // per-locale JSONB) was held in memory at once.
    if (
      (writeScope === 'STRUCTURE' || writeScope === 'STRUCTURE_REMAP') &&
      sourceProvider === structureDecision.provider
    ) {
      await this.syncSeasons(mediaId, data.seasons, lang, enData?.seasons, episodeExternalProvider);
    } else if (
      data.seasons.length > 0 &&
      (writeScope === 'STRUCTURE' || writeScope === 'STRUCTURE_REMAP')
    ) {
      this.logger.warn(
        `persistShow: blocked ${sourceProvider} structure write for ${mediaId}; canonical provider is ${structureDecision.provider} (scope=${writeScope})`,
      );
    }
    // TMDB reviews ride the one-call hydration (append=reviews); TVDB carries none.
    if (data.reviews && this.externalReviews) {
      await this.externalReviews
        .syncMediaReviews(mediaId!, data.reviews)
        .catch((e) =>
          this.logger.debug(`Review sync skipped for ${mediaId}: ${(e as Error).message}`),
        );
    }
    return mediaId!;
  }

  private async persistMovie(
    data: NormalizedMovie,
    existingId?: string,
    lang: string = currentLanguage(),
    enData?: NormalizedMovie,
    // Source of `data` — only TMDB hydration is authoritative for watch offers
    // (TVDB supplies none; syncing from it would wipe TMDB-persisted links).
    source: ExternalProvider = ExternalProvider.TMDB,
  ): Promise<string> {
    // Serialize concurrent hydrations of the same media (see withMediaWriteLock).
    // NormalizedMovie carries no tvdbId; TVDB-hydrated movies arrive with tmdbId=0 and
    // an existingId from the light upsert, so the id-less fallback is rare and benign.
    const lockKey = existingId ?? `${source}:movie:${data.tmdbId}`;
    return this.withMediaWriteLock(lockKey, () =>
      this.persistMovieLocked(data, existingId, lang, enData, source),
    );
  }

  private async persistMovieLocked(
    data: NormalizedMovie,
    existingId: string | undefined,
    lang: string,
    enData: NormalizedMovie | undefined,
    source: ExternalProvider,
  ): Promise<string> {
    const mediaId = await this.prisma.$transaction(
      async (tx) => {
        let prev = existingId
          ? await tx.mediaItem.findUnique({
              where: { id: existingId },
              select: {
                titles: true,
                overviews: true,
                posterUrls: true,
                backdropUrls: true,
                type: true,
              },
            })
          : null;
        // Cross-type guard (mirror of persistShow): movie data must NEVER merge into a SHOW row.
        if (prev && prev.type !== MediaType.MOVIE) {
          this.logger.warn(
            `persistMovie: refusing to merge movie into ${prev.type} row ${existingId} — creating a new movie row`,
          );
          existingId = undefined;
          prev = null;
        }
        const genres = await this.upsertGenres(tx, data.genres, lang, enData?.genres);
        const providers = await this.upsertProviders(tx, data.providers);
        const castMembers = await this.upsertCast(tx, data.cast);

        const englishTranslation = data.translations?.en;
        const englishBase =
          enData ??
          (englishTranslation?.title?.trim()
            ? {
                ...data,
                title: englishTranslation.title.trim(),
                overview: englishTranslation.overview ?? data.overview,
              }
            : undefined);

        let titles = mergeLocalized(prev?.titles as any, lang, data.title, englishBase?.title);
        let overviews = mergeLocalized(
          prev?.overviews as any,
          lang,
          data.overview,
          englishBase?.overview,
        );
        // Bulk-store ALL translations from the provider (e.g. TVDB movie meta=translations).
        if (data.translations) {
          for (const [loc, tr] of Object.entries(data.translations)) {
            titles = mergeLocalized(titles as any, loc, tr.title ?? undefined, undefined);
            overviews = mergeLocalized(overviews as any, loc, tr.overview ?? undefined, undefined);
          }
        }

        const base = englishBase ?? data;
        const mediaData = {
          title: base.title,
          overview: base.overview,
          posterUrl: base.posterUrl,
          backdropUrl: base.backdropUrl,
          rating: data.rating,
          popularity: data.popularity ?? 0,
          trailerUrl: data.trailerUrl,
          metadataRefreshedAt: new Date(),
          // The marker describes the base JUST WRITTEN (base = enData ?? data in `lang`).
          // Never inherit prev.titleLocale — a stale non-en marker would survive an
          // English re-hydration and the row would stay "non-English base" forever.
          titleLocale: englishBase ? 'en' : lang,
          titles,
          overviews,
          posterUrls: mergeLocalized(
            prev?.posterUrls as any,
            lang,
            data.posterUrl,
            englishBase?.posterUrl,
          ),
          backdropUrls: mergeLocalized(
            prev?.backdropUrls as any,
            lang,
            data.backdropUrl,
            englishBase?.backdropUrl,
          ),
          // TVDB supplies no recommendations — never clobber the TMDB snapshot.
          ...(data.recommendations
            ? { recommendations: data.recommendations as any, recommendationsSyncedAt: new Date() }
            : {}),
          // TVDB supplies no watch offers — never clobber the TMDB per-country blob.
          ...(data.providersByCountry ? { watchProviders: data.providersByCountry as any } : {}),
        };

        let mediaId = existingId;
        if (existingId) {
          await tx.mediaItem.update({ where: { id: existingId }, data: mediaData });
        } else {
          const created = await tx.mediaItem.create({
            data: {
              ...mediaData,
              type: MediaType.MOVIE,
              // Externals attach via the conflict-safe upsert loop below (same as persistShow).
            },
          });
          mediaId = created.id;
        }

        // Upsert externals (conflict-safe: a parked id on another row is left in place).
        for (const e of data.externals) {
          await tx.externalId.upsert({
            where: {
              provider_providerEntityKind_value: {
                provider: e.provider,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: e.value,
              },
            },
            create: {
              mediaId: mediaId!,
              provider: e.provider,
              providerEntityKind: ProviderEntityKind.MOVIE,
              value: e.value,
            },
            update: {},
          });
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
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
          update: {
            releaseDate: data.releaseDate ? new Date(data.releaseDate) : null,
            releaseYear: data.releaseYear,
            runtimeMinutes: data.runtimeMinutes,
            country: data.country,
            language: data.language,
            ...(data.keywords ? { keywords: data.keywords as any } : {}),
          },
        });

        await this.syncGenres(tx, mediaId!, genres);
        // Only TMDB hydration is authoritative for watch offers (see persistShow).
        if (source === ExternalProvider.TMDB) {
          await this.syncProviders(tx, mediaId!, providers);
        }
        await this.syncCast(tx, mediaId!, castMembers, data.cast, lang, englishBase?.cast);

        return mediaId!;
      },
      { timeout: 60_000 },
    );
    // TMDB reviews ride the one-call hydration (append=reviews); TVDB carries none.
    if (data.reviews && this.externalReviews) {
      await this.externalReviews
        .syncMediaReviews(mediaId!, data.reviews)
        .catch((e) =>
          this.logger.debug(`Review sync skipped for ${mediaId}: ${(e as Error).message}`),
        );
    }
    return mediaId!;
  }

  // ---- Read helpers ----
  private fullShowInclude(userId?: string) {
    return {
      show: {
        include: {
          seasons: {
            where: { episodes: { some: { structureState: 'ACTIVE' } } },
            include: { episodes: { where: { structureState: 'ACTIVE' } } },
          },
        },
      },
      genres: { include: { genre: true } },
      providers: { include: { provider: true } },
      cast: { include: { castMember: true } },
      externalIds: true,
      ...(userId
        ? {
            watchlist: { where: { userId }, select: { id: true } },
            favorites: { where: { userId }, select: { id: true } },
            showStatuses: {
              where: { userId },
              select: {
                id: true,
                watchedCount: true,
                totalCount: true,
                dropped: true,
                pausedAt: true,
              },
            },
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
    // "Original title" is a details-page-only extra, and only for ANIME whose original
    // language isn't the user's (e.g. a Japanese title for an English user). Anything
    // else keeps the field empty so non-anime originals never clutter the page.
    const hasAnimation = (media.genres ?? []).some(
      (g: any) => g.genre?.slug === 'animation' || g.genre?.name?.toLowerCase?.() === 'animation',
    );
    const hasAnimeKeyword = ((media.show.keywords ?? []) as string[]).some(
      (keyword) => String(keyword).trim().toLowerCase() === 'anime',
    );
    const isAnime = hasAnimation && hasAnimeKeyword;
    const originalLanguage = media.show.originalLanguage;
    const userBaseLang = currentLanguage().split('-')[0];
    if (
      !isAnime ||
      !originalLanguage ||
      originalLanguage === userBaseLang ||
      !dto.originalTitle ||
      dto.originalTitle === dto.title
    ) {
      dto.originalTitle = null;
    }
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
          where: {
            userId,
            watched: true,
            episode: {
              structureState: 'ACTIVE',
              season: { show: { mediaId }, isSpecial: false },
            },
          },
        }),
        this.prisma.episode.count({
          where: {
            structureState: 'ACTIVE',
            season: { show: { mediaId }, isSpecial: false },
            airDate: { not: null, lte: now },
          },
        }),
      ]);
      userProgress = totalEp > 0 ? watchedEp / totalEp : 0;
    }

    return {
      ...dto,
      seasons,
      seasonsWithSpecials: specials,
      seasonRatings,
      userProgress,
      recommendations: recommendationsDto(media.recommendations),
    };
  }

  private async computeSeasonRatings(mediaId: string) {
    // Source of truth for the chart = YOUR app users' ratings.
    // Unrated episodes count as 0 unless USE_API_FOR_EPISODES_CHART=true (then TMDb fills gaps).
    const useApi = this.config.get<boolean>('metadata.useApiRatingsForChart') === true;
    // One aggregate query — the old findMany loaded every episode of the show plus
    // every user rating row ever cast on it (thousands of rows) to average in JS,
    // on every show-detail view.
    const eps = await this.prisma.$queryRaw<
      {
        number: number;
        seasonNumber: number;
        tmdbRating: number | null;
        votes: number;
        avg: number | null;
      }[]
    >`
      SELECT e.number, s.number AS "seasonNumber", e.rating AS "tmdbRating",
             COUNT(r.id)::int AS votes, AVG(r.rating)::float AS avg
      FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      LEFT JOIN ratings r ON r.episode_id = e.id
      WHERE sh.media_id = ${mediaId}
        AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
      GROUP BY e.id, e.number, s.number, e.rating
    `;
    const bySeason = new Map<number, { number: number; rating: number; votes: number }[]>();
    for (const e of eps) {
      const votes = e.votes;
      const userAvg = votes ? e.avg : null;
      let value: number;
      if (userAvg != null) {
        value = userAvg; // 1–5 from your users
      } else if (useApi && e.tmdbRating) {
        value = e.tmdbRating / 2; // TMDb 0–10 scaled to 0–5
      } else {
        value = 0; // no user ratings yet
      }
      const sn = e.seasonNumber;
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
              where: { episodes: { some: { structureState: 'ACTIVE' } } },
              orderBy: { number: 'asc' },
              include: {
                episodes: {
                  where: { structureState: 'ACTIVE' },
                  orderBy: { number: 'asc' },
                  ...(userId
                    ? {
                        include: {
                          userStatuses: {
                            where: { userId },
                            select: {
                              watched: true,
                              watchedAt: true,
                              device: true,
                              watchCount: true,
                            },
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
              movieStatuses: {
                where: { userId },
                select: { id: true, watched: true, watchedAt: true, watchCount: true },
              },
            }
          : {}),
      },
    });
    if (!media || !media.movie) throw new NotFoundException('Movie not found');
    return {
      ...mapMovie(media as any, userId),
      recommendations: recommendationsDto(media.recommendations),
    };
  }

  // ---- Mapping normalized seasons/episodes ----
  /**
   * Persist a show's seasons ONE PER TRANSACTION. Mega-dailies (Jeopardy! 15k eps,
   * Days of our Lives 9k) previously upserted every episode inside the caller's single
   * interactive transaction: ~30k serial statements blew the 60s timeout and silently
   * rolled back the whole hydration, and the up-front existing-rows read held the
   * show's ENTIRE episode graph (fat per-locale JSONB) in memory. Per-season txs cap
   * both: memory stays at one season, a slow season can't roll back the others, and a
   * crash mid-show leaves committed progress behind (upserts are idempotent — the next
   * hydration completes the rest). On season failures the freshness stamp is cleared
   * so the 24h gate retries immediately instead of leaving gaps for a day.
   */
  private async syncSeasons(
    mediaId: string,
    seasons: NormalizedSeason[],
    lang: string = currentLanguage(),
    enSeasons?: NormalizedSeason[],
    episodeExternalProvider: ExternalProvider = ExternalProvider.TMDB,
  ) {
    const show = await this.prisma.show.findUnique({ where: { mediaId } });
    if (!show) return;
    const failed: number[] = [];
    for (const s of seasons) {
      const enS = enSeasons?.find((e) => e.number === s.number);
      try {
        await this.prisma.$transaction(
          (tx) => this.syncOneSeason(tx, show.id, s, enS, lang, episodeExternalProvider),
          { timeout: 60_000 },
        );
      } catch (e) {
        failed.push(s.number);
        this.logger.error(
          `syncSeasons: season ${s.number} of media ${mediaId} failed: ${(e as Error).message}`,
        );
      }
    }
    if (failed.length > 0) {
      await this.prisma.mediaItem
        .update({ where: { id: mediaId }, data: { metadataRefreshedAt: null } })
        .catch(() => undefined);
      throw new Error(
        `syncSeasons: ${failed.length} season(s) failed for media ${mediaId}: ${failed.join(', ')}`,
      );
    }
  }

  /** Persist one season + its episodes (runs inside its own transaction). */
  private async syncOneSeason(
    tx: PrismaTransaction,
    showId: string,
    s: NormalizedSeason,
    enS: NormalizedSeason | undefined,
    lang: string,
    episodeExternalProvider: ExternalProvider,
  ) {
    // Existing season/episode JSON (per-season read — keeps peak memory at one season)
    // to merge locale overrides without clobbering other locales.
    const prev = await tx.season.findUnique({
      where: { showId_number: { showId, number: s.number } },
      select: {
        number: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        episodes: {
          where: { structureState: 'ACTIVE' },
          select: {
            id: true,
            number: true,
            titles: true,
            overviews: true,
            stillUrls: true,
            externalIds: {
              where: { provider: episodeExternalProvider },
              select: { id: true },
            },
          },
        },
      },
    });
    const airedCount = (eps: NormalizedSeason['episodes']) =>
      eps.filter((e) => e.airDate && new Date(e.airDate) <= new Date()).length;
    // Skip empty season shells: no episodes from the provider AND no existing episodes.
    // Prevents broken "0/0 watched" rows when a provider (e.g. TVDB) is rate-limited/empty.
    if ((!s.episodes || s.episodes.length === 0) && (s.episodeCount ?? 0) === 0) {
      if (!prev || (prev.episodes?.length ?? 0) === 0) return;
    }
    const titles = mergeLocalized(prev?.titles as any, lang, s.title, enS?.title);
    const overviews = mergeLocalized(prev?.overviews as any, lang, s.overview, enS?.overview);
    const posterUrls = mergeLocalized(prev?.posterUrls as any, lang, s.posterUrl, enS?.posterUrl);
    // Seasons retain their stable identity. Episodes are provider-aware: during a
    // remap, a canonical row may need to be staged beside a provider-foreign row with
    // the same S/E coordinates so user data can be transferred safely afterward.
    const season = await tx.season.upsert({
      where: { showId_number: { showId, number: s.number } },
      create: {
        showId,
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
    const epMap = new Map<number, NonNullable<typeof prev>['episodes']>();
    for (const previous of prev?.episodes ?? []) {
      if (previous.externalIds.length === 0) continue;
      epMap.set(previous.number, [...(epMap.get(previous.number) ?? []), previous]);
    }
    for (const e of s.episodes) {
      const enE = enS?.episodes.find((ee) => ee.number === e.number);
      const ownerRows = epMap.get(e.number) ?? [];
      if (ownerRows.length > 1) {
        throw new Error(
          `multiple active ${episodeExternalProvider} episodes at S${s.number}E${e.number}`,
        );
      }
      let prevEp = ownerRows[0];
      if (e.tmdbId && typeof (tx.episodeExternalId as any).findUnique === 'function') {
        const exact = await tx.episodeExternalId.findUnique({
          where: {
            provider_providerEntityKind_value: {
              provider: episodeExternalProvider,
              providerEntityKind: ProviderEntityKind.EPISODE,
              value: String(e.tmdbId),
            },
          },
          include: {
            episode: {
              select: {
                id: true,
                number: true,
                titles: true,
                overviews: true,
                stillUrls: true,
                structureState: true,
                externalIds: { select: { id: true } },
                season: { select: { showId: true } },
              },
            },
          },
        });
        if (exact?.episode?.season.showId !== undefined && exact.episode.season.showId !== showId) {
          throw new Error(
            `${episodeExternalProvider} episode id ${e.tmdbId} belongs to another show`,
          );
        }
        if (exact?.episode?.structureState === EpisodeStructureState.ACTIVE) {
          if (prevEp && prevEp.id !== exact.episode.id) {
            throw new Error(
              `conflicting active ${episodeExternalProvider} identities at S${s.number}E${e.number}`,
            );
          }
          prevEp = exact.episode;
        }
      }
      const epTitles = mergeLocalized(prevEp?.titles as any, lang, e.title, enE?.title);
      const epOverviews = mergeLocalized(prevEp?.overviews as any, lang, e.overview, enE?.overview);
      const epStillUrls = mergeLocalized(prevEp?.stillUrls as any, lang, e.stillUrl, enE?.stillUrl);
      const episodeData = {
        seasonId: season.id,
        number: e.number,
        absoluteNumber: e.absoluteNumber ?? null,
        title: enE?.title ?? e.title,
        overview: enE?.overview ?? e.overview,
        stillUrl: enE?.stillUrl ?? e.stillUrl,
        runtimeMinutes: e.runtimeMinutes,
        airDate: e.airDate ? new Date(e.airDate) : null,
        rating: e.rating,
        isFinale: e.isFinale,
        structureState: EpisodeStructureState.ACTIVE,
        titles: epTitles,
        overviews: epOverviews,
        stillUrls: epStillUrls,
      };
      const episodeUpdate = {
        seasonId: season.id,
        number: e.number,
        // Backfill only — never wipe an existing value with a provider that
        // supplies none (null means "unknown", not "cleared").
        ...(e.absoluteNumber != null ? { absoluteNumber: e.absoluteNumber } : {}),
        title: enE?.title ?? e.title,
        overview: enE?.overview ?? e.overview,
        stillUrl: enE?.stillUrl ?? e.stillUrl,
        runtimeMinutes: e.runtimeMinutes,
        airDate: e.airDate ? new Date(e.airDate) : null,
        rating: e.rating,
        isFinale: e.isFinale,
        structureState: EpisodeStructureState.ACTIVE,
        titles: epTitles,
        overviews: epOverviews,
        stillUrls: epStillUrls,
      };
      const ep = prevEp
        ? await tx.episode.update({ where: { id: prevEp.id }, data: episodeUpdate })
        : await tx.episode.create({ data: episodeData });
      // Persist the provider's episode id so import matching can resolve episodes by
      // external id (EpisodeExternalId fast path + /find recovery). `e.tmdbId` carries
      // the TMDB episode id for TMDB hydration, the TVDB episode id for TVDB hydration.
      if (e.tmdbId) {
        await this.syncEpisodeExternalId(tx, ep.id, episodeExternalProvider, String(e.tmdbId));
      }
    }
  }

  /** Persist one episode-level external id. Existing ownership is never hijacked; exact
   * same-show identities are selected before this method is called. */
  private async syncEpisodeExternalId(
    tx: PrismaTransaction,
    episodeId: string,
    provider: ExternalProvider,
    value: string,
  ) {
    try {
      await tx.episodeExternalId.upsert({
        where: {
          provider_providerEntityKind_value: {
            provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value,
          },
        },
        create: { episodeId, provider, providerEntityKind: ProviderEntityKind.EPISODE, value },
        update: {},
      });
    } catch (e) {
      this.logger.debug(
        `episodeExternalId upsert failed for ${provider}:${value}: ${(e as Error).message}`,
      );
    }
  }

  async ensureUserShowTotals(userId: string, mediaId: string) {
    const total = await this.prisma.episode.count({
      where: { structureState: 'ACTIVE', season: { show: { mediaId }, isSpecial: false } },
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
    for (const [index, g] of genres.entries()) {
      // Match the English name (stable identity) so different request languages
      // collapse onto the same Genre row instead of creating per-language dupes.
      const enName =
        enGenres?.find((e) => e.tmdbId != null && e.tmdbId === g.tmdbId)?.name ??
        // TVDB genres carry no tmdbId — but the provider returns the same genre set in
        // the same order for every locale, so the English name lines up by index.
        (enGenres && enGenres.length === genres.length ? enGenres[index]?.name : undefined);
      const slug = slugify(enName ?? g.name);
      const existing = await tx.genre
        .findUnique({ where: { slug }, select: { names: true } })
        .catch(() => null);
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

  private async upsertProviders(
    tx: PrismaTransaction,
    providers: { name: string; logoUrl?: string | null }[],
  ) {
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

  private async upsertCast(
    tx: PrismaTransaction,
    cast: {
      tmdbPersonId: number;
      name: string;
      profileUrl?: string | null;
      personExternalId?: string;
    }[],
  ): Promise<Map<string, string>> {
    const byExternal = new Map<string, { name: string; profileUrl?: string | null }>();
    for (const c of cast) {
      // Provider-namespaced id (TMDB_/TVDB_) — see NormalizedCast.personExternalId.
      const key = c.personExternalId ?? `TMDB_${c.tmdbPersonId}`;
      if (!byExternal.has(key)) {
        byExternal.set(key, { name: c.name, profileUrl: c.profileUrl });
      }
    }
    // externalId -> castMemberId (callers resolve per cast entry; a person with
    // multiple roles appears once here but may repeat in the cast array).
    const ids = new Map<string, string>();
    for (const [externalId, info] of byExternal) {
      const member = await tx.castMember.upsert({
        where: { externalId },
        create: { externalId, name: info.name, profileUrl: info.profileUrl },
        update: { name: info.name, profileUrl: info.profileUrl ?? undefined },
      });
      ids.set(externalId, member.id);
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
    castMemberIds: Map<string, string>,
    cast: {
      tmdbPersonId?: number;
      character?: string | null;
      characterExternalId?: number | null;
      order: number;
      personExternalId?: string;
    }[],
    lang: string = currentLanguage(),
    enCast?: {
      tmdbPersonId?: number;
      character?: string | null;
      characterExternalId?: number | null;
      order: number;
      personExternalId?: string;
    }[],
  ) {
    // Preserve other locales' characters: read existing JSON before recreating rows.
    const existing = await tx.mediaCast.findMany({
      where: { mediaId },
      select: { id: true, castMemberId: true, characters: true, characterExternalId: true },
    });
    const existingMap = new Map(existing.map((c) => [c.castMemberId, c]));
    // Legacy rows created when TVDB people ids lived under the TMDB_ namespace can be
    // matched by their TVDB character id and repointed to the correctly-namespaced
    // cast member IN PLACE — media_cast.id (and its character votes) is preserved.
    const byCharacterExt = new Map<number, (typeof existing)[number]>();
    for (const row of existing) {
      if (row.characterExternalId != null && !byCharacterExt.has(row.characterExternalId)) {
        byCharacterExt.set(row.characterExternalId, row);
      }
    }
    const castKey = (c?: { tmdbPersonId?: number; personExternalId?: string } | null) =>
      c?.personExternalId ?? (c?.tmdbPersonId != null ? `TMDB_${c.tmdbPersonId}` : null);
    const seen = new Set<string>();
    const retainedIds: string[] = [];
    for (let i = 0; i < cast.length; i++) {
      const c = cast[i];
      const key = castKey(c);
      // One row per (media, person): repeated roles of the same person are skipped
      // (first/best-billed role wins) instead of creating duplicate media_cast rows.
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const id = castMemberIds.get(key);
      if (!id) continue;
      let prev = existingMap.get(id);
      let repoint = false;
      if (!prev && c?.characterExternalId != null) {
        const legacy = byCharacterExt.get(c.characterExternalId);
        if (legacy && legacy.castMemberId !== id) {
          prev = legacy;
          repoint = true;
        } else if (legacy) {
          prev = legacy;
        }
      }
      const enChar = enCast?.find(
        (e) => e.tmdbPersonId != null && e.tmdbPersonId === c?.tmdbPersonId,
      )?.character;
      const prevCharacters =
        prev?.characters && typeof prev.characters === 'object' && !Array.isArray(prev.characters)
          ? (prev.characters as Record<string, string>)
          : null;
      const characters = mergeLocalized(prevCharacters, lang, c?.character, enChar);
      const data = {
        character: enChar ?? c?.character ?? null,
        characters,
        sortOrder: c?.order ?? i,
        // Keep TVDB role ids when a later TMDB refresh lacks them; imported TV Time
        // character votes depend on this local key.
        characterExternalId: c?.characterExternalId ?? prev?.characterExternalId ?? null,
      };
      let retainedId: string;
      if (prev) {
        await tx.mediaCast.update({
          where: { id: prev.id },
          data: repoint ? { ...data, castMemberId: id } : data,
        });
        retainedId = prev.id;
      } else {
        const created = await tx.mediaCast.create({
          data: {
            mediaId,
            castMemberId: id,
            ...data,
          },
          select: { id: true },
        });
        retainedId = created.id;
      }
      retainedIds.push(retainedId);
      if (c.characterExternalId != null) {
        await tx.mediaCastExternalId.upsert({
          where: {
            mediaId_provider_value: {
              mediaId,
              provider: ExternalProvider.THE_TVDB,
              value: String(c.characterExternalId),
            },
          },
          create: {
            mediaId,
            castId: retainedId,
            provider: ExternalProvider.THE_TVDB,
            value: String(c.characterExternalId),
          },
          update: { castId: retainedId },
        });
      }
    }
    // Delete stale cast rows only when no character votes point at them. Votes use
    // media_cast.id as the stable option key, so deleting voted rows would cascade-delete
    // imported/manual character votes.
    await tx.mediaCast.deleteMany({
      where: {
        mediaId,
        ...(retainedIds.length ? { id: { notIn: retainedIds } } : {}),
        characterVotes: { none: {} },
        externalIds: { none: {} },
      },
    });
    // Self-heal INSIDE the hydration transaction: merge any duplicate cast rows this
    // sync created or retained (cross-namespace person ids, name variants) instead of
    // leaving them for the weekly batch repair — hydrations and character-id
    // backfills would otherwise keep growing duplicates between cron runs. Optional
    // chaining: some test harnesses construct the service with a reduced dep set.
    if (this.castDedup) {
      await this.castDedup.mergeInline(tx, mediaId);
    }
  }
}

/** Defensive parse of the media_items.recommendations JSON snapshot → DTO.
 *  Unknown/garbled shapes (legacy rows, partial writes) become an empty array. */
function recommendationsDto(raw: unknown): RecommendationDto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, any> => !!r && typeof r === 'object')
    .filter((r) => typeof r.tmdbId === 'number')
    .map((r) => ({
      tmdbId: r.tmdbId,
      type: r.type === 'MOVIE' ? ('MOVIE' as const) : ('SHOW' as const),
      title: typeof r.title === 'string' && r.title ? r.title : 'Untitled',
      posterUrl: typeof r.posterUrl === 'string' ? r.posterUrl : null,
      year: typeof r.year === 'number' ? r.year : null,
      rating: typeof r.rating === 'number' ? r.rating : null,
    }));
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
