import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Prisma, ListSource } from '@prisma/client';
import { COMMENT_SPOILER_THRESHOLD, MediaType } from '@tvwatch/shared';
import { shadowEmail, shadowUsername } from './lib/shadow-user';
import { isDeletedUserAccount } from '../users/lib/deleted-user';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { SettingService } from '../common/setting.service';
import { CommentImageProcessor } from '../comment-images/comment-image.processor';
import { IMPORT_LIMITS } from './lib/limits';
import { ImportStorage } from './lib/storage';
import { ImportMatcher } from './lib/matcher';
import { normTitle, normalizeNumericExternalId } from './lib/inference';
import { STRUCTURE_PENDING_ERROR, STRUCTURE_REVIEW_ERROR } from './lib/structure-pending';
import { ImportProcessor } from './import.processor';
import { HydrationQueue } from '../media-metadata/hydration/hydration.queue';
import { InvalidUploadError } from './errors';
import { randomUUID } from 'crypto';

const EXT_TO_SOURCE: Record<string, 'zip' | 'csv' | 'json'> = {
  zip: 'zip',
  csv: 'csv',
  json: 'json',
};

const BATCH_CHUNK = 5000;
// Leave headroom below PostgreSQL's hard 32,767 bind-variable ceiling. Bulk
// inserts multiply row count by column count, so their row chunk is calculated
// dynamically from this parameter budget.
const MAX_QUERY_BIND_PARAMS = 30_000;
// Interactive transaction limits. The apply stage splits work across multiple short
// transactions (one per section) instead of one giant transaction, but each section still
// needs headroom beyond Prisma's 5s default — that default is what caused the 500 on large
// exports (P2028 timeout).
const TX_TIMEOUT = Number(process.env.IMPORT_TX_TIMEOUT_MS) || 60_000;
const TX_MAXWAIT = Number(process.env.IMPORT_TX_MAXWAIT_MS) || 10_000;

/**
 * Manual episode/show → movie retype: when the user explicitly matches an episode- or
 * show-scoped item to a MOVIE, the item is rewritten to its movie equivalent so the
 * apply lands as movie data, including favorite-character votes on the movie itself.
 */
const EPISODE_TO_MOVIE_RETYPE: Record<string, string> = {
  WATCHED_EPISODE: 'WATCHED_MOVIE',
  EPISODE_RATING: 'MOVIE_RATING',
  SHOW_RATING: 'MOVIE_RATING',
  EPISODE_EMOTION: 'MOVIE_EMOTION',
  EPISODE_COMMENT: 'MOVIE_COMMENT',
  SHOW_COMMENT: 'MOVIE_COMMENT',
  WATCHLIST_SHOW: 'WATCHLIST_MOVIE',
  FAVORITE_SHOW: 'FAVORITE_MOVIE',
  EPISODE_CHARACTER_VOTE: 'MOVIE_CHARACTER_VOTE',
};

const EPISODE_SCOPED_IMPORT_TYPES = new Set([
  'WATCHED_EPISODE',
  'EPISODE_RATING',
  'EPISODE_EMOTION',
  'EPISODE_COMMENT',
  'EPISODE_CHARACTER_VOTE',
]);

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly pendingVoteReconcileInflight = new Set<string>();
  private readonly pendingStructureReconcileInflight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ImportStorage,
    private readonly processor: ImportProcessor,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
    private readonly settings: SettingService,
    private readonly matcher: ImportMatcher,
    private readonly commentImages: CommentImageProcessor,
    private readonly hydration: HydrationQueue,
    // Optional: spec factories construct the service positionally without it;
    // the cache purge below is best-effort and must never fail an import.
    @Optional() private readonly redis?: RedisService,
  ) {}

  // ---------------- upload ----------------
  async upload(
    userId: string,
    file: { buffer: Buffer; originalname: string; size: number },
    locale?: string,
  ) {
    if (!file) throw new InvalidUploadError('No file received');
    if (file.size > IMPORT_LIMITS.MAX_UPLOAD_BYTES) {
      throw new InvalidUploadError(`File exceeds ${IMPORT_LIMITS.MAX_UPLOAD_BYTES} bytes`);
    }
    const ext = (file.originalname.split('.').pop() || '').toLowerCase();
    const sourceType = EXT_TO_SOURCE[ext];
    if (!sourceType) throw new InvalidUploadError('Only .zip, .csv or .json are accepted');

    // Daily limit is admin-controlled (Settings → limits → IMPORT_DAILY_LIMIT); falls back to
    // the env config, then the hardcoded default. Read live so admin changes take effect.
    const dailyLimit = await this.settings.getNumber('IMPORT_DAILY_LIMIT', NaN);
    const effectiveLimit =
      Number.isFinite(dailyLimit) && dailyLimit > 0
        ? dailyLimit
        : (this.config.get<number>('imports.dailyLimit') ?? IMPORT_LIMITS.DAILY_IMPORTS_PER_USER);
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await this.prisma.import.count({
      where: { userId, createdAt: { gte: since } },
    });
    if (todayCount >= effectiveLimit) {
      throw new BadRequestException(`Daily import limit (${effectiveLimit}) reached`);
    }

    const imp = await this.prisma.import.create({
      data: {
        userId,
        sourceType,
        originalFilename: file.originalname,
        status: 'UPLOADED',
        locale: locale || null,
      },
    });
    const key = await this.storage.write(imp.id, file.originalname, file.buffer);
    await this.prisma.import.update({
      where: { id: imp.id },
      data: { storageKey: key, status: 'QUEUED' },
    });
    await this.processor.enqueue(imp.id);
    return { importId: imp.id, status: 'QUEUED' };
  }

  /** Non-terminal statuses — the imports a user can still resume. */
  private static readonly PENDING_STATUSES = [
    'UPLOADED',
    'QUEUED',
    'EXTRACTING',
    'PARSING',
    'NORMALIZING',
    'MATCHING',
    'READY_FOR_REVIEW',
    'IMPORTING',
  ] as const;

  /** The user's latest unfinished import (drives the "continue import?" prompt). */
  async getResumable(userId: string) {
    const imp = await this.prisma.import.findFirst({
      where: { userId, status: { in: [...ImportService.PENDING_STATUSES] } as any },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        progress: true,
        originalFilename: true,
        createdAt: true,
        matchedCount: true,
        needsReviewCount: true,
        unmatchedCount: true,
      },
    });
    return { import: imp };
  }

  /** Cancel every unfinished import (used when the user chooses "start new" — the old
   *  imports never trigger the resume prompt again; re-uploading stays idempotent). */
  async dismissPending(userId: string) {
    const res = await this.prisma.import.updateMany({
      where: { userId, status: { in: [...ImportService.PENDING_STATUSES] } as any },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
    return { dismissed: res.count };
  }

  // ---------------- status / files / items ----------------
  async getStatus(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) return null;
    // Import-wide totals for the review banner. Shows/movies count DISTINCT identities:
    // the matched media row when matched (classified by the MEDIA'S real type — a v1
    // movie-row that resolved cross-type to a SHOW counts as a show, never as a movie),
    // else the item's title identity (classified by the item's family) so unmatched
    // shows/movies still count, mirroring the source app's library counts. SKIPPED out.
    const [mediaCounts, typeGroups] = await Promise.all([
      this.prisma.$queryRaw<[{ shows: bigint | number; movies: bigint | number }]>`
        SELECT
          COUNT(DISTINCT COALESCE(ii.matched_media_id, 'title:' || COALESCE(ii.normalized_data->>'normTitle', ii.normalized_data->>'title', ''))) FILTER (
            WHERE m.type = 'SHOW'
              OR (ii.matched_media_id IS NULL AND (
                ii.source_entity_type IN ('WATCHLIST_SHOW','FAVORITE_SHOW','WATCHED_EPISODE','EPISODE_RATING','EPISODE_EMOTION','EPISODE_COMMENT','EPISODE_CHARACTER_VOTE','SHOW_COMMENT','SHOW_RATING')
                OR (ii.source_entity_type = 'LIST_ITEM' AND ii.normalized_data->>'mediaType' = 'series')
              ))
          ) AS shows,
          COUNT(DISTINCT COALESCE(ii.matched_media_id, 'title:' || COALESCE(ii.normalized_data->>'normTitle', ii.normalized_data->>'title', ''))) FILTER (
            WHERE m.type = 'MOVIE'
              OR (ii.matched_media_id IS NULL AND (
                ii.source_entity_type IN ('WATCHED_MOVIE','WATCHLIST_MOVIE','FAVORITE_MOVIE','MOVIE_RATING','MOVIE_EMOTION','MOVIE_COMMENT')
                OR (ii.source_entity_type = 'LIST_ITEM' AND ii.normalized_data->>'mediaType' = 'movie')
              ))
          ) AS movies
        FROM import_items ii
        LEFT JOIN media_items m ON m.id = ii.matched_media_id
        WHERE ii.import_id = ${importId} AND ii.status != 'SKIPPED'
      `,
      this.prisma.importItem.groupBy({
        by: ['sourceEntityType'],
        where: { importId, status: { not: 'SKIPPED' } },
        _count: { _all: true },
      }),
    ]);
    const byType: Record<string, number> = {};
    for (const g of typeGroups) byType[g.sourceEntityType] = g._count._all;
    const sum = (...keys: string[]) => keys.reduce((n, k) => n + (byType[k] ?? 0), 0);
    return {
      ...imp,
      importTotals: {
        shows: Number(mediaCounts[0]?.shows ?? 0),
        movies: Number(mediaCounts[0]?.movies ?? 0),
        lists: byType['LIST'] ?? 0,
        comments: sum('EPISODE_COMMENT', 'MOVIE_COMMENT', 'SHOW_COMMENT'),
        reactions: sum('EPISODE_EMOTION', 'MOVIE_EMOTION'),
        ratings: sum('EPISODE_RATING', 'MOVIE_RATING', 'SHOW_RATING'),
        characterVotes:
          (byType['EPISODE_CHARACTER_VOTE'] ?? 0) + (byType['MOVIE_CHARACTER_VOTE'] ?? 0),
      },
    };
  }

  getFiles(userId: string, importId: string) {
    return this.prisma.importFile.findMany({ where: { importId, import: { userId } } });
  }

  async getItems(
    userId: string,
    importId: string,
    opts: {
      status?: string;
      hideUnmatched?: boolean;
      entity?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    // Verify ownership separately (the `import` relation filter is unreliable due to the reserved word)
    const owned = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!owned) throw new NotFoundException('Import not found');

    const page = opts.page || 1;
    // The review UI deliberately requests one stable page: offset pagination drifts while
    // manual resolutions move rows between statuses. Keep the server cap aligned with that
    // client contract so "All types" cannot silently omit rows beyond the first 200.
    const pageSize = Math.min(opts.pageSize || 50, 500);
    const where: any = { importId };
    if (opts.status) where.status = opts.status.toUpperCase();
    else if (opts.hideUnmatched) where.status = { not: 'UNMATCHED' };
    const entityWhere: any = { ...where };
    if (opts.entity && isNaN(Number(opts.entity))) {
      // Single type or comma-separated group (e.g. "FAVORITE_SHOW,FAVORITE_MOVIE" for the
      // Favorites chip, "LIST,LIST_ITEM" for the Lists chip in the review UI).
      const types = opts.entity
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      if (types.length === 1) where.sourceEntityType = types[0];
      else if (types.length > 1) where.sourceEntityType = { in: types };
    }
    const [items, total, entityGroups] = await Promise.all([
      this.prisma.importItem.findMany({
        where,
        orderBy: [{ status: 'asc' }, { confidenceScore: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.importItem.count({ where }),
      // Per-entity-type counts under the ACTIVE STATUS filter only (entity filter ignored)
      // — drives the per-chip counters in the review UI.
      this.prisma.importItem.groupBy({
        by: ['sourceEntityType'],
        where: entityWhere,
        _count: { _all: true },
      }),
    ]);
    const entityCounts: Record<string, number> = {};
    for (const g of entityGroups) entityCounts[g.sourceEntityType] = g._count._all;
    return { items, total, page, pageSize, entityCounts };
  }

  async patchItem(
    userId: string,
    importId: string,
    itemId: string,
    dto: { matchedMediaId?: string; userResolution?: string },
  ) {
    const item = await this.prisma.importItem.findFirst({
      where: { id: itemId, importId, import: { userId } },
    });
    if (!item) throw new NotFoundException('Import item not found');
    const data: any = {};
    if (dto.matchedMediaId) {
      data.matchedMediaId = dto.matchedMediaId;
      data.confidenceScore = 1;
      data.status = 'MATCHED';
      // Manual match to a MOVIE for an episode/show-scoped item: the user's intent wins —
      // retype it to the movie equivalent so the apply lands as movie data (watched /
      // rated / reacted / commented / watchlisted / favorited / character-voted).
      const media = await this.prisma.mediaItem.findUnique({
        where: { id: dto.matchedMediaId },
        select: { type: true },
      });
      const retyped =
        media?.type === 'MOVIE' ? EPISODE_TO_MOVIE_RETYPE[item.sourceEntityType] : undefined;
      if (retyped) {
        data.sourceEntityType = retyped;
        data.targetEntityType = retyped;
        data.matchedEpisodeId = null;
      }
    }
    if (dto.userResolution) data.userResolution = dto.userResolution;
    if (dto.userResolution === 'skip') data.status = 'SKIPPED';
    const updated = await this.prisma.importItem.update({ where: { id: itemId }, data });
    await this.recountImportStatuses(importId);
    return updated;
  }

  /**
   * Resolve every unresolved item belonging to the same source show (by title) to a single
   * chosen media. Used by the "apply to all episodes" checkbox: the user picks the correct
   * show once and every NEEDS_REVIEW episode/rating/emotion/comment for that source title is
   * matched. Episode entities are resolved to their specific episode by S/E.
   *
   * When `season` is provided, ONLY items in that source season are resolved — this handles
   * anthology imports where one source show's seasons are actually distinct real shows
   * (e.g. "The Haunting" S1 = Hill House, S2 = Bly Manor).
   */
  async resolveAllForShow(
    userId: string,
    importId: string,
    matchedMediaId: string,
    sourceTitle: string,
    season?: number | null,
  ): Promise<{ resolved: number; matched: number; needsReview: number }> {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');

    const target = await this.prisma.mediaItem.findUnique({
      where: { id: matchedMediaId },
      select: { type: true },
    });
    const targetIsMovie = target?.type === 'MOVIE';
    // Ensure the chosen show has seasons/episodes so episode resolution can work.
    if (!targetIsMovie) await this.matcher.ensureShowHydrated(matchedMediaId);

    // Exact normalized title — NO year stripping: "One Piece" and "ONE PIECE (2023)" are
    // DIFFERENT shows, and bulk-resolving across year variants mismatches whole libraries.
    const nt = normTitle(sourceTitle);
    if (!nt) {
      // The source title carries no letters/digits in any script — a title match would
      // hit every other letter-less title. Never bulk-resolve on an empty identity.
      this.logger.warn(
        `resolveAllForShow: refusing to bulk-resolve an empty title identity (import ${importId})`,
      );
      return { resolved: 0, matched: 0, needsReview: 0 };
    }
    const items = await this.prisma.importItem.findMany({
      where: { importId, status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
    });

    const EPISODE_ENTITIES = [
      'WATCHED_EPISODE',
      'EPISODE_RATING',
      'EPISODE_EMOTION',
      'EPISODE_COMMENT',
      'EPISODE_CHARACTER_VOTE',
    ];
    const selectedItems = items.filter((it) => {
      const norm: any = it.normalizedData ?? {};
      const title = norm.showTitle ?? norm.title;
      if (!title || normTitle(title) !== nt) return false;
      // Per-season scoping: only resolve items in the chosen source season (anthology support).
      const itemSeason = Number(norm.season ?? norm.seasonNumber);
      return !(season != null && Number.isFinite(itemSeason) && itemSeason !== season);
    });

    if (!targetIsMovie) {
      const coordinates = selectedItems
        .filter((item) => EPISODE_ENTITIES.includes(item.sourceEntityType))
        .map((item) => {
          const norm: any = item.normalizedData ?? {};
          return {
            season: Number(norm.season ?? norm.seasonNumber),
            episode: Number(norm.episode ?? norm.episodeNumber),
          };
        });
      // Manual selection proves the show identity. If its current graph cannot contain an
      // imported coordinate (Lost S6E18 is the canonical TMDB-one/TVDB-two example), run the
      // same strict Metadata Health authority workflow synchronously, then resolve against the
      // repaired graph below. Optional chaining keeps lightweight spec factories compatible.
      await this.matcher.reconcileStructureForMissingEpisodes?.(matchedMediaId, coordinates);
    }

    let resolved = 0;
    let matched = 0;
    let needsReview = 0;
    for (const it of selectedItems) {
      const norm: any = it.normalizedData ?? {};

      let status = 'MATCHED';
      let episodeId: string | null = null;
      if (targetIsMovie) {
        // Manual intent wins: episode/show-scoped items matched to a MOVIE are retyped to
        // their movie equivalent (watched/rated/reacted/commented/watchlisted/favorited/
        // character-voted).
        const retyped = EPISODE_TO_MOVIE_RETYPE[it.sourceEntityType];
        if (retyped) {
          await this.prisma.importItem.update({
            where: { id: it.id },
            data: {
              matchedMediaId,
              matchedEpisodeId: null,
              sourceEntityType: retyped as any,
              targetEntityType: retyped as any,
              status: 'MATCHED',
              confidenceScore: 1,
            },
          });
          resolved++;
          matched++;
          continue;
        }
        await this.prisma.importItem.update({
          where: { id: it.id },
          data: { matchedMediaId, status: 'NEEDS_REVIEW', confidenceScore: 0 },
        });
        resolved++;
        needsReview++;
        continue;
      }
      if (EPISODE_ENTITIES.includes(it.sourceEntityType)) {
        const season = Number(norm.season ?? norm.seasonNumber);
        const episode = Number(norm.episode ?? norm.episodeNumber);
        if (Number.isFinite(season) && Number.isFinite(episode)) {
          // Lenient: the user explicitly mapped this (source) season to a different show, so
          // fall back to the episode number in any season (anthology: source S2 → target S1).
          episodeId = await this.matcher.resolveEpisode(matchedMediaId, season, episode, true);
        }
        status = episodeId ? 'MATCHED' : 'NEEDS_REVIEW';
      }

      await this.prisma.importItem.update({
        where: { id: it.id },
        data: {
          matchedMediaId,
          matchedEpisodeId: episodeId,
          status: status as 'MATCHED' | 'NEEDS_REVIEW',
          confidenceScore: episodeId ? 1 : 0.7,
        },
      });
      resolved++;
      if (status === 'MATCHED') matched++;
      else needsReview++;
    }

    // Keep the Import summary counters in sync with the new item statuses.
    await this.recountImportStatuses(importId);
    return { resolved, matched, needsReview };
  }

  /**
   * Resolve-by-name: bulk-resolve the items currently visible in the review UI (the
   * caller's status + entity filter) using their source titles. A candidate is accepted
   * ONLY when the name actually matches (see matcher.matchByTitleVerified — language
   * aware, footprint-disambiguated for shows). Episode-scoped items resolve their episode
   * by S/E after the show is hydrated. Returns counts so the UI can report the outcome.
   */
  async resolveByName(
    userId: string,
    importId: string,
    opts: { status?: string; entity?: string },
  ): Promise<{ examined: number; resolved: number; stillUnresolved: number }> {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');

    const where: any = {
      importId,
      status: opts.status ? opts.status.toUpperCase() : { in: ['NEEDS_REVIEW', 'UNMATCHED'] },
      // LIST rows are containers, not media — never resolve them by name.
      sourceEntityType: { not: 'LIST' },
    };
    if (opts.entity) {
      const types = opts.entity
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((t) => Boolean(t) && t !== 'LIST'); // containers are never name-resolved
      if (types.length === 1) where.sourceEntityType = types[0];
      else if (types.length > 1) where.sourceEntityType = { in: types };
    }
    const items = await this.prisma.importItem.findMany({ where, take: 500 });

    const EPISODE_ENTITIES = [
      'WATCHED_EPISODE',
      'EPISODE_RATING',
      'EPISODE_EMOTION',
      'EPISODE_COMMENT',
      'EPISODE_CHARACTER_VOTE',
    ];
    const titleOf = (it: any): string | null => {
      const n: any = it.normalizedData ?? {};
      const t = n.showTitle ?? n.movieTitle ?? n.title;
      return typeof t === 'string' && t.trim() ? t.trim() : null;
    };
    const typeOf = (it: any): 'SHOW' | 'MOVIE' =>
      /MOVIE/.test(String(it.sourceEntityType)) ? 'MOVIE' : 'SHOW';

    // Group by media type + normalized title: one provider search per distinct title.
    const groups = new Map<string, { type: 'SHOW' | 'MOVIE'; title: string; items: any[] }>();
    for (const it of items) {
      const title = titleOf(it);
      if (!title) continue;
      const type = typeOf(it);
      const key = `${type}:${normTitle(title)}`;
      if (!groups.has(key)) groups.set(key, { type, title, items: [] });
      groups.get(key)!.items.push(it);
    }

    let examined = 0;
    let resolved = 0;
    for (const g of groups.values()) {
      examined += g.items.length;

      // Season/episode footprint (shows): the candidate must contain the referenced S/E.
      let hint: {
        maxSeason?: number | null;
        seasonEpisodes?: { season: number; maxEpisode: number }[] | null;
      } | null = null;
      if (g.type === 'SHOW') {
        let maxSeason: number | null = null;
        const seMap = new Map<number, number>();
        for (const it of g.items) {
          const n: any = it.normalizedData ?? {};
          const s = Number(n.season ?? n.seasonNumber);
          const e = Number(n.episode ?? n.episodeNumber);
          if (Number.isFinite(s)) {
            maxSeason = Math.max(maxSeason ?? 0, s);
            if (Number.isFinite(e)) seMap.set(s, Math.max(seMap.get(s) ?? 0, e));
          }
        }
        if (maxSeason != null || seMap.size) {
          hint = {
            maxSeason,
            seasonEpisodes: [...seMap.entries()].map(([season, maxEpisode]) => ({
              season,
              maxEpisode,
            })),
          };
        }
      }

      const m = await this.matcher.matchByTitleVerified(normTitle(g.title), g.title, g.type, hint);
      if (!m.mediaId) continue;
      if (g.type === 'SHOW') await this.matcher.ensureShowHydrated(m.mediaId);

      for (const it of g.items) {
        let episodeId: string | null = null;
        if (EPISODE_ENTITIES.includes(String(it.sourceEntityType))) {
          const n: any = it.normalizedData ?? {};
          const season = Number(n.season ?? n.seasonNumber);
          const episode = Number(n.episode ?? n.episodeNumber);
          const rawEpId = n.externalEpisodeId != null ? Number(n.externalEpisodeId) : null;
          if (Number.isFinite(season) && Number.isFinite(episode)) {
            episodeId =
              (rawEpId
                ? await this.matcher.resolveEpisodeByExternalIds(m.mediaId, { tvdb: rawEpId })
                : null) ??
              (await this.matcher.resolveEpisode(m.mediaId, season, episode)) ??
              (rawEpId ? await this.matcher.recoverEpisodeByTvdbId(m.mediaId, rawEpId) : null);
          }
          if (!episodeId) continue; // show matched but episode missing → leave for manual review
        }
        const upd = await this.prisma.importItem.updateMany({
          where: { id: it.id, status: { in: ['NEEDS_REVIEW', 'UNMATCHED'] } },
          data: {
            matchedMediaId: m.mediaId,
            matchedEpisodeId: episodeId,
            status: 'MATCHED',
            confidenceScore: m.confidence,
          },
        });
        resolved += upd.count;
      }
    }

    await this.recountImportStatuses(importId);
    return { examined, resolved, stillUnresolved: examined - resolved };
  }

  /** Recompute the Import row's status counters from the current ImportItem statuses.
   *  ONLY row-backed counters (matched/unmatched/needsReview) — duplicates, invalid and
   *  conflict are processing counters with NO row equivalent (skipped rows are never
   *  staged), so recounting them from statuses would wipe them to zero. */
  private async recountImportStatuses(importId: string) {
    const groups = await this.prisma.importItem.groupBy({
      by: ['status'],
      where: { importId },
      _count: { _all: true },
    });
    const counts: Record<string, number> = {};
    for (const g of groups) counts[g.status] = g._count._all;
    await this.prisma.import.update({
      where: { id: importId },
      data: {
        matchedCount: counts['MATCHED'] ?? 0,
        unmatchedCount: counts['UNMATCHED'] ?? 0,
        needsReviewCount: counts['NEEDS_REVIEW'] ?? 0,
      },
    });
  }

  // ---------------- confirm + apply (batched, per-section transactions) ----------------
  async confirm(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    const isRetryableApplyFailure = imp.status === 'FAILED' && imp.processedAt != null;
    if (imp.status !== 'READY_FOR_REVIEW' && !isRetryableApplyFailure) {
      throw new BadRequestException(`Import cannot be confirmed (status=${imp.status})`);
    }
    await this.prisma.import.update({
      where: { id: importId },
      data: { status: 'IMPORTING', progress: 0 },
    });

    // Load not-yet-applied matched items (incl. PENDING_MATCH: items waiting on queued
    // background re-matching — a re-confirm after that work completes picks them up).
    // Each section marks its items APPLIED inside its own transaction, so a retry
    // (BullMQ or manual re-confirm) only reprocesses leftover items and never
    // duplicates already-applied data.
    const stagedItems = await this.prisma.importItem.findMany({
      where: {
        importId,
        status: { in: ['MATCHED', 'PENDING_MATCH'] },
        OR: [{ userResolution: null }, { userResolution: { not: 'skip' } }],
      },
    });
    // Structure-pending rows deliberately have no trusted episode FK yet. Confirm and
    // complete everything else; the metadata worker will rematch and apply these rows.
    const items = stagedItems.filter((item) => item.errorMessage !== STRUCTURE_PENDING_ERROR);

    let created = 0;
    let skipped = 0;
    try {
      // Provider source tag (TVTIME | TRAKT) — keeps the two imports idempotent independently.
      const source: ListSource = imp.format === 'trakt' ? 'TRAKT' : 'TVTIME';
      // Claim any shadow account previously created for THIS user's TV Time id (their
      // comments arrived as third-party replies in OTHER users' imports) BEFORE applying —
      // the apply's dedupe then sees those comments under the real user. A claiming
      // failure must never block the import itself.
      try {
        await this.claimShadowAccount(userId, importId, imp.ownerExternalId, source);
      } catch (e) {
        this.logger.warn(
          `Import ${importId}: shadow claim failed (continuing): ${(e as Error).message}`,
        );
      }
      const res = await this.applyBatch(userId, importId, items, source);
      created = res.created;
      skipped = res.skipped;
      await this.prisma.import.update({
        where: { id: importId },
        data: { status: 'COMPLETED', completedAt: new Date(), progress: 100 },
      });
      // Queue-only: never make confirmation wait for provider comparison or migration.
      await this.enqueuePendingStructureEvaluations(importId).catch((e) =>
        this.logger.warn(
          `Import ${importId}: background structure reconciliation enqueue deferred: ${(e as Error).message}`,
        ),
      );
      // A cast refresh may finish before the import reaches COMPLETED, in which case the
      // event listener intentionally ignores it to avoid racing this apply. Re-check once
      // after completion: already-resolved votes apply immediately; missing cast ids stay
      // pending until the queued CAST_ONLY refresh emits its completion event.
      await this.reconcilePendingCharacterVotes({ importId, terminalUnresolved: false }).catch(
        (e) =>
          this.logger.warn(
            `Import ${importId}: pending character-vote reconciliation deferred: ${(e as Error).message}`,
          ),
      );
      // A FAILED retry excludes section-level APPLIED items from `items`. Rebuild from every
      // episode item in the import so shows completed before the original failure are included.
      const rebuildItems = await this.prisma.importItem.findMany({
        where: {
          importId,
          sourceEntityType: 'WATCHED_EPISODE',
          matchedMediaId: { not: null },
        },
        select: { sourceEntityType: true, matchedMediaId: true },
      });
      await this.rebuildShowStatuses(userId, rebuildItems);
      // The import rewrote the user's whole library: bust the per-user
      // watch-next/upcoming/progress caches AND the for-you ranking (same
      // pattern set as TrackingService.invalidateUserCache), otherwise the
      // pre-import (often empty) sections linger until the 5-min TTL.
      if (this.redis) {
        await Promise.all([
          this.redis.delByPattern(`watchnext:${userId}:*`),
          this.redis.delByPattern(`upcoming:${userId}:*`),
          this.redis.delByPattern(`showsprogress:${userId}:*`),
          this.redis.delByPattern(`foryou:v3:${userId}:*`),
          this.redis.del(`watchnext:${userId}`),
          this.redis.del(`upcoming:${userId}`),
        ]).catch(() => undefined);
      }
      this.events.emit('import.applied', { userId });
    } catch (e) {
      this.logger.error(`Apply failed for import ${importId}: ${(e as Error).message}`);
      await this.prisma.import
        .update({
          where: { id: importId },
          data: { status: 'FAILED', errorMessage: (e as Error).message?.slice(0, 1000) },
        })
        .catch(() => undefined);
      throw e;
    } finally {
      // Guaranteed temp-file cleanup regardless of success or failure.
      try {
        await this.storage.delete(imp.storageKey!);
      } catch {
        // best-effort cleanup
      }
    }
    return { importId, created, skipped };
  }

  /** Summary of the rating/emotion/comment counts for the result/preview UI. */
  async getSummary(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    return {
      ratingsDetected: imp.ratingsDetected,
      ratingsImported: imp.ratingsImported,
      ratingsUpdated: imp.ratingsUpdated,
      ratingsSkippedUnsupported: imp.ratingsSkippedUnsupported,
      ratingsSkippedUnresolved: imp.ratingsSkippedUnresolved,
      ratingDuplicatesIgnored: imp.ratingDuplicatesIgnored,
      emotionsDetected: imp.emotionsDetected,
      emotionsImported: imp.emotionsImported,
      emotionsSkippedUnsupported: imp.emotionsSkippedUnsupported,
      emotionsSkippedUnresolved: imp.emotionsSkippedUnresolved,
      emotionDuplicatesIgnored: imp.emotionDuplicatesIgnored,
      commentRowsDetected: imp.commentRowsDetected,
      topLevelCommentsDetected: imp.topLevelCommentsDetected,
      commentsImported: imp.commentsImported,
      commentRepliesSkipped: imp.commentRepliesSkipped,
      commentActivityRowsSkipped: imp.commentActivityRowsSkipped,
      commentsByOtherUsersSkipped: imp.commentsByOtherUsersSkipped,
      commentsSkippedUnresolved: imp.commentsSkippedUnresolved,
      commentDuplicatesIgnored: imp.commentDuplicatesIgnored,
      commentsSkippedInvalid: imp.commentsSkippedInvalid,
      characterVotesDetected: imp.characterVotesDetected,
      characterVotesImported: imp.characterVotesImported,
      characterVotesSkippedUnresolved: imp.characterVotesSkippedUnresolved,
      characterVoteDuplicatesIgnored: imp.characterVoteDuplicatesIgnored,
      characterVotesSkippedInvalid: imp.characterVotesSkippedInvalid,
    };
  }

  private chunkedCreateMany(tx: any, model: string, rows: any[], skipDuplicates = false) {
    const columnCount = Math.max(1, new Set(rows.flatMap((row) => Object.keys(row ?? {}))).size);
    const chunkSize = Math.max(
      1,
      Math.min(BATCH_CHUNK, Math.floor(MAX_QUERY_BIND_PARAMS / columnCount)),
    );
    const work: Promise<unknown>[] = [];
    for (let i = 0; i < rows.length; i += chunkSize) {
      work.push(tx[model].createMany({ data: rows.slice(i, i + chunkSize), skipDuplicates }));
    }
    return Promise.all(work);
  }

  /**
   * PostgreSQL prepared statements accept at most 32,767 bind variables. Large
   * archives can exceed that with a single Prisma `in` filter, so every bulk ID
   * lookup is deduplicated and loaded in the same bounded chunks used by writes.
   */
  private async chunkedFindManyByIds<T>(
    ids: string[],
    load: (chunk: string[]) => Promise<T[]>,
  ): Promise<T[]> {
    const uniqueIds = [...new Set(ids)];
    const rows: T[] = [];
    for (let i = 0; i < uniqueIds.length; i += BATCH_CHUNK) {
      rows.push(...(await load(uniqueIds.slice(i, i + BATCH_CHUNK))));
    }
    return rows;
  }

  /** Keep updateMany `id IN (...)` statements below PostgreSQL's bind limit too. */
  private async chunkedUpdateManyByIds(tx: any, model: string, ids: string[], data: any) {
    const uniqueIds = [...new Set(ids)];
    for (let i = 0; i < uniqueIds.length; i += BATCH_CHUNK) {
      await tx[model].updateMany({
        where: { id: { in: uniqueIds.slice(i, i + BATCH_CHUNK) } },
        data,
      });
    }
  }

  /**
   * Prepared imports can outlive a metadata structure repair. Validate every episode-scoped
   * target before any apply section writes its FK, then repair stale ids entirely from the
   * local database. A TVDB episode identity is authoritative: if its active alias is absent we
   * fail closed instead of attaching it to a possibly incompatible TMDB S/E coordinate.
   */
  private async repairStagedEpisodeTargets(
    importId: string,
    items: any[],
  ): Promise<{ repaired: number; skipped: number }> {
    const episodeItems = items.filter(
      (item) =>
        EPISODE_SCOPED_IMPORT_TYPES.has(item.sourceEntityType) &&
        item.matchedMediaId &&
        item.matchedEpisodeId &&
        (item.status === 'MATCHED' || item.status === 'PENDING_MATCH'),
    );
    if (!episodeItems.length) return { repaired: 0, skipped: 0 };

    const stagedEpisodeIds = episodeItems.map((item) => item.matchedEpisodeId as string);
    const activeEpisodes = await this.chunkedFindManyByIds(stagedEpisodeIds, (ids) =>
      this.prisma.episode.findMany({
        where: { id: { in: ids }, structureState: 'ACTIVE' },
        select: {
          id: true,
          season: { select: { show: { select: { mediaId: true } } } },
        },
      }),
    );
    const activeTargetKeys = new Set(
      activeEpisodes.map((episode: any) => `${episode.season.show.mediaId}:${episode.id}`),
    );
    const staleItems = episodeItems.filter(
      (item) => !activeTargetKeys.has(`${item.matchedMediaId}:${item.matchedEpisodeId}`),
    );
    if (!staleItems.length) return { repaired: 0, skipped: 0 };

    const externalEpisodeIdOf = (item: any): string | null => {
      const normalized = item.normalizedData ?? {};
      const raw = item.rawData ?? {};
      const value =
        normalized.externalEpisodeId ??
        normalized.episodeIds?.tvdb ??
        raw.externalEpisodeId ??
        raw.rawTvdbEpisodeId ??
        raw.tvdbEpisodeId ??
        raw.episodeIds?.tvdb;
      if (value == null || String(value).trim() === '') return null;
      return String(value).trim();
    };
    const externalIdByItem = new Map(
      staleItems.map((item) => [item.id as string, externalEpisodeIdOf(item)]),
    );
    const externalIds = [
      ...new Set([...externalIdByItem.values()].filter((value): value is string => !!value)),
    ];
    const aliasRows = externalIds.length
      ? await this.chunkedFindManyByIds(externalIds, (values) =>
          this.prisma.episodeExternalId.findMany({
            where: {
              provider: 'THE_TVDB',
              providerEntityKind: 'EPISODE',
              value: { in: values },
              episode: { structureState: 'ACTIVE' },
            },
            select: {
              value: true,
              episodeId: true,
              episode: {
                select: { season: { select: { show: { select: { mediaId: true } } } } },
              },
            },
          }),
        )
      : [];
    const aliasTargets = new Map<string, Set<string>>();
    for (const row of aliasRows as any[]) {
      const key = `${row.episode.season.show.mediaId}:${row.value}`;
      const targets = aliasTargets.get(key) ?? new Set<string>();
      targets.add(row.episodeId);
      aliasTargets.set(key, targets);
    }

    const coordinateOf = (
      item: any,
    ): { mediaId: string; season: number; episode: number } | null => {
      const normalized = item.normalizedData ?? {};
      const raw = item.rawData ?? {};
      const seasonValue =
        normalized.seasonNumber ?? normalized.season ?? raw.seasonNumber ?? raw.season;
      const episodeValue =
        normalized.episodeNumber ?? normalized.episode ?? raw.episodeNumber ?? raw.episode;
      const season = seasonValue == null ? Number.NaN : Number(seasonValue);
      const episode = episodeValue == null ? Number.NaN : Number(episodeValue);
      const special = normalized.special === true || raw.special === true;
      if (
        special ||
        !Number.isInteger(season) ||
        season <= 0 ||
        !Number.isInteger(episode) ||
        episode <= 0
      ) {
        return null;
      }
      return { mediaId: item.matchedMediaId, season, episode };
    };
    const coordinateKey = (coordinate: { mediaId: string; season: number; episode: number }) =>
      `${coordinate.mediaId}:${coordinate.season}:${coordinate.episode}`;
    const coordinateByItem = new Map<string, ReturnType<typeof coordinateOf>>();
    const coordinateRequests = new Map<
      string,
      { mediaId: string; season: number; episode: number }
    >();
    for (const item of staleItems) {
      // An explicit provider identity must resolve through its alias. Positional fallback is
      // reserved for older rows that never carried an external episode id.
      if (externalIdByItem.get(item.id)) continue;
      const coordinate = coordinateOf(item);
      coordinateByItem.set(item.id, coordinate);
      if (coordinate) coordinateRequests.set(coordinateKey(coordinate), coordinate);
    }

    const coordinateRows: any[] = [];
    const coordinates = [...coordinateRequests.values()];
    for (let index = 0; index < coordinates.length; index += 250) {
      const batch = coordinates.slice(index, index + 250);
      coordinateRows.push(
        ...(await this.prisma.episode.findMany({
          where: {
            structureState: 'ACTIVE',
            OR: batch.map((coordinate) => ({
              season: {
                show: { mediaId: coordinate.mediaId },
                number: coordinate.season,
              },
              number: coordinate.episode,
            })),
          },
          select: {
            id: true,
            number: true,
            season: {
              select: { number: true, show: { select: { mediaId: true } } },
            },
          },
        })),
      );
    }
    const coordinateTargets = new Map<string, Set<string>>();
    for (const row of coordinateRows) {
      const key = coordinateKey({
        mediaId: row.season.show.mediaId,
        season: row.season.number,
        episode: row.number,
      });
      const targets = coordinateTargets.get(key) ?? new Set<string>();
      targets.add(row.id);
      coordinateTargets.set(key, targets);
    }

    const replacementGroups = new Map<string, any[]>();
    const unresolvedItems: any[] = [];
    for (const item of staleItems) {
      const externalId = externalIdByItem.get(item.id);
      const targets = externalId
        ? aliasTargets.get(`${item.matchedMediaId}:${externalId}`)
        : coordinateByItem.get(item.id)
          ? coordinateTargets.get(coordinateKey(coordinateByItem.get(item.id)!))
          : undefined;
      const replacementId = targets?.size === 1 ? [...targets][0] : null;
      if (!replacementId) {
        unresolvedItems.push(item);
        continue;
      }
      item.matchedEpisodeId = replacementId;
      const group = replacementGroups.get(replacementId) ?? [];
      group.push(item);
      replacementGroups.set(replacementId, group);
    }

    for (const [replacementId, group] of replacementGroups) {
      await this.chunkedUpdateManyByIds(
        this.prisma,
        'importItem',
        group.map((item) => item.id),
        { matchedEpisodeId: replacementId, errorMessage: null },
      );
    }
    if (unresolvedItems.length) {
      await this.chunkedUpdateManyByIds(
        this.prisma,
        'importItem',
        unresolvedItems.map((item) => item.id),
        {
          status: 'SKIPPED',
          matchedEpisodeId: null,
          errorMessage: 'Episode is missing or its canonical replacement is ambiguous',
        },
      );
      for (const item of unresolvedItems) {
        item.status = 'SKIPPED';
        item.matchedEpisodeId = null;
      }
    }

    const repaired = [...replacementGroups.values()].reduce((sum, group) => sum + group.length, 0);
    this.logger.warn(
      `Import ${importId}: stale episode preflight repaired ${repaired} target(s) and safely skipped ${unresolvedItems.length}`,
    );
    return { repaired, skipped: unresolvedItems.length };
  }

  /** Apply every section, each in its own raised-timeout transaction (no single giant tx). */
  private async applyBatch(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
  ): Promise<{ created: number; skipped: number }> {
    let created = 0;
    let skipped = 0;

    // Metadata repairs may replace episode rows after an import reached review. Repair every
    // episode-scoped activity before ratings/reactions/comments can write a stale FK.
    const episodePreflight = await this.repairStagedEpisodeTargets(importId, items);
    skipped += episodePreflight.skipped;

    // Apply progress: 9 fixed sections run sequentially below; bump after each one.
    let sectionsDone = 0;
    const SECTIONS_TOTAL = 9;
    const sectionDone = async () => {
      sectionsDone++;
      await this.prisma.import
        .update({
          where: { id: importId },
          data: { progress: Math.round((sectionsDone / SECTIONS_TOTAL) * 100) },
        })
        .catch(() => undefined);
    };

    const epItems = items.filter(
      (it) => it.sourceEntityType === 'WATCHED_EPISODE' && it.matchedMediaId && it.matchedEpisodeId,
    );
    const movieItemsRaw = items.filter(
      (it) => it.sourceEntityType === 'WATCHED_MOVIE' && it.matchedMediaId,
    );
    const watchlistItemsRaw = items.filter(
      (it) =>
        (it.sourceEntityType === 'WATCHLIST_SHOW' || it.sourceEntityType === 'WATCHLIST_MOVIE') &&
        it.matchedMediaId,
    );
    const favoriteItemsRaw = items.filter(
      (it) =>
        (it.sourceEntityType === 'FAVORITE_SHOW' || it.sourceEntityType === 'FAVORITE_MOVIE') &&
        it.matchedMediaId,
    );

    // Cross-type guard: user data must never be applied to a media row of the wrong
    // entity type (a mis-tagged import item or a bad external-id cross-link could
    // otherwise write movie statuses/history onto shows). One batched type read.
    const guardIds = [
      ...new Set(
        [...epItems, ...movieItemsRaw, ...watchlistItemsRaw, ...favoriteItemsRaw].map(
          (it) => it.matchedMediaId as string,
        ),
      ),
    ];
    const typeRows = await this.chunkedFindManyByIds(guardIds, (ids) =>
      this.prisma.mediaItem.findMany({
        where: { id: { in: ids } },
        select: { id: true, type: true },
      }),
    );
    const typeById = new Map(typeRows.map((r) => [r.id, r.type]));
    const incompatibleItems: any[] = [];
    const guardFilter = (it: any, expected: string): boolean => {
      if (typeById.get(it.matchedMediaId) === expected) return true;
      skipped++;
      incompatibleItems.push(it);
      this.logger.warn(
        `apply guard: dropping ${it.sourceEntityType} item ${it.id} — matched media is ${typeById.get(it.matchedMediaId) ?? 'missing'}, expected ${expected}`,
      );
      return false;
    };
    const epItemsGuarded = epItems.filter((it) => guardFilter(it, 'SHOW'));
    const movieItems = movieItemsRaw.filter((it) => guardFilter(it, 'MOVIE'));
    const watchlistItems = watchlistItemsRaw.filter((it) =>
      guardFilter(it, it.sourceEntityType === 'WATCHLIST_MOVIE' ? 'MOVIE' : 'SHOW'),
    );
    const favoriteItems = favoriteItemsRaw.filter((it) =>
      guardFilter(it, it.sourceEntityType === 'FAVORITE_MOVIE' ? 'MOVIE' : 'SHOW'),
    );
    if (incompatibleItems.length) {
      await this.chunkedUpdateManyByIds(
        this.prisma,
        'importItem',
        incompatibleItems.map((item) => item.id),
        {
          status: 'SKIPPED',
          errorMessage: 'Matched media type is incompatible with this import item',
        },
      );
    }

    // --- WATCHED EPISODES ---
    if (epItemsGuarded.length) {
      const applicableEpItems = epItemsGuarded;
      const episodeIds = applicableEpItems.map((item) => item.matchedEpisodeId as string);
      const [episodeData, existingWatched] = await Promise.all([
        this.chunkedFindManyByIds(episodeIds, (ids) =>
          this.prisma.episode.findMany({
            where: { id: { in: ids }, structureState: 'ACTIVE' },
            select: { id: true, runtimeMinutes: true, season: { select: { number: true } } },
          }),
        ),
        this.chunkedFindManyByIds(episodeIds, (ids) =>
          this.prisma.userEpisodeStatus.findMany({
            where: { userId, episodeId: { in: ids }, watched: true },
            select: { id: true, episodeId: true, watchCount: true },
          }),
        ),
      ]);
      const runtimeMap = new Map<string, any>(episodeData.map((e: any) => [e.id, e]));
      const watchedSet = new Set(existingWatched.map((e: any) => e.episodeId));
      // Existing per-episode watchCount — used to upgrade episodes imported before the
      // rewatch feature (stuck at 1) when a richer export is re-imported.
      const existingByEpisode = new Map<string, { id: string; watchCount: number }>(
        existingWatched.map((e: any) => [e.episodeId, { id: e.id, watchCount: e.watchCount ?? 0 }]),
      );

      // The same episode may be described by multiple import items (seen_episode_source
      // single watch + rewatched_episode total count via cpt). Collapse them to the
      // authoritative highest watchCount per resolved episode so the rewatch tally wins
      // even when the two files spell the show title differently (→ different normTitle,
      // → not merged earlier, but same matchedEpisodeId here).
      const watchCountByEpisode = new Map<string, number>();
      for (const it of applicableEpItems) {
        const c = Math.max(1, Number(it.normalizedData?.watchCount) || 1);
        watchCountByEpisode.set(
          it.matchedEpisodeId,
          Math.max(watchCountByEpisode.get(it.matchedEpisodeId) ?? 1, c),
        );
      }

      const epStatusRows: any[] = [];
      const historyRows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      const appliedInBatch = new Set<string>();
      const bumpUpdates: { id: string; watchCount: number }[] = [];
      let sectionCreated = 0;
      let sectionBumped = 0;
      for (const it of applicableEpItems) {
        const epId = it.matchedEpisodeId;
        const importedCount = watchCountByEpisode.get(epId) ?? 1;

        if (watchedSet.has(epId)) {
          // Already watched — almost always a prior import. If this export now carries a
          // higher rewatch count (e.g. imported before rewatch support), upgrade the tally.
          // Take the max only, so manual rewatches are never decreased; skip otherwise.
          // Mirrors the codebase rule of never overwriting manual/local data.
          const existing = existingByEpisode.get(epId);
          if (existing && importedCount > existing.watchCount) {
            bumpUpdates.push({ id: existing.id, watchCount: importedCount });
            // Reflect the bump in-memory so a sibling item for the same episode (rewatched
            // vs seen_episode_source) doesn't bump it again within this batch.
            existingByEpisode.set(epId, { id: existing.id, watchCount: importedCount });
            auditRows.push({
              id: randomUUID(),
              importId,
              importItemId: it.id,
              targetTable: 'user_episode_status',
              targetRecordId: existing.id,
              action: 'updated',
            });
            appliedIds.push(it.id);
            sectionBumped++;
          } else {
            skipped++;
          }
          continue;
        }

        // New episode — skip if a sibling item already created it in this batch.
        if (appliedInBatch.has(epId)) {
          skipped++;
          continue;
        }
        appliedInBatch.add(epId);
        const norm: any = it.normalizedData ?? {};
        const epData: any = runtimeMap.get(epId);
        const watchedAt = norm.watchedAt ? new Date(norm.watchedAt) : new Date();
        const watchCount = importedCount;
        const statusId = randomUUID();
        epStatusRows.push({
          id: statusId,
          userId,
          episodeId: epId,
          watched: true,
          watchedAt,
          watchCount,
        });
        historyRows.push({
          id: randomUUID(),
          userId,
          mediaId: it.matchedMediaId,
          mediaType: MediaType.SHOW,
          episodeId: epId,
          seasonNumber: epData?.season?.number ?? norm.season ?? null,
          episodeNumber: norm.episode ?? null,
          runtimeMinutes: epData?.runtimeMinutes ?? null,
          watchedAt,
        });
        auditRows.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'user_episode_status',
          targetRecordId: statusId,
          action: 'created',
        });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (epStatusRows.length || bumpUpdates.length) {
        await this.prisma.$transaction(
          async (tx) => {
            await this.chunkedCreateMany(tx, 'userEpisodeStatus', epStatusRows, true);
            await this.chunkedCreateMany(tx, 'watchHistory', historyRows);
            await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
            // Upgrade watchCount (max only) for already-watched episodes whose imported
            // tally is now higher than what was previously stored.
            if (bumpUpdates.length) {
              await Promise.all(
                bumpUpdates.map((b) =>
                  tx.userEpisodeStatus.update({
                    where: { id: b.id },
                    data: { watchCount: b.watchCount },
                  }),
                ),
              );
            }
            if (appliedIds.length) {
              await this.chunkedUpdateManyByIds(tx, 'importItem', appliedIds, {
                status: 'APPLIED',
              });
            }
          },
          { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
        );
      }
      created += sectionCreated + sectionBumped;
    }
    await sectionDone();

    // --- WATCHED MOVIES ---
    if (movieItems.length) {
      const movieMediaIds = movieItems.map((it) => it.matchedMediaId);
      const [movieData, existingWatchedMovies] = await Promise.all([
        this.chunkedFindManyByIds(movieMediaIds, (ids) =>
          this.prisma.movie.findMany({
            where: { mediaId: { in: ids } },
            select: { mediaId: true, runtimeMinutes: true },
          }),
        ),
        this.chunkedFindManyByIds(movieMediaIds, (ids) =>
          this.prisma.userMovieStatus.findMany({
            where: { userId, mediaId: { in: ids }, watched: true },
            select: { mediaId: true },
          }),
        ),
      ]);
      const runtimeMap = new Map(movieData.map((m: any) => [m.mediaId, m.runtimeMinutes]));
      const watchedMovieSet = new Set(existingWatchedMovies.map((m: any) => m.mediaId));

      const movieStatusRows: any[] = [];
      const movieHistoryRows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of movieItems) {
        const mediaId = it.matchedMediaId;
        if (watchedMovieSet.has(mediaId)) {
          skipped++;
          continue;
        }
        const norm: any = it.normalizedData ?? {};
        const watchedAt = norm.watchedAt ? new Date(norm.watchedAt) : new Date();
        const watchCount = Math.max(1, Number(norm.watchCount) || 1);
        const statusId = randomUUID();
        movieStatusRows.push({
          id: statusId,
          userId,
          mediaId,
          watched: true,
          watchedAt,
          watchCount,
        });
        movieHistoryRows.push({
          id: randomUUID(),
          userId,
          mediaId,
          mediaType: MediaType.MOVIE,
          runtimeMinutes: runtimeMap.get(mediaId) ?? null,
          watchedAt,
        });
        auditRows.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'user_movie_status',
          targetRecordId: statusId,
          action: 'created',
        });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (movieStatusRows.length) {
        await this.prisma.$transaction(
          async (tx) => {
            await this.chunkedCreateMany(tx, 'userMovieStatus', movieStatusRows, true);
            await this.chunkedCreateMany(tx, 'watchHistory', movieHistoryRows);
            await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
            if (appliedIds.length) {
              await this.chunkedUpdateManyByIds(tx, 'importItem', appliedIds, {
                status: 'APPLIED',
              });
            }
          },
          { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
        );
      }
      created += sectionCreated;
    }
    await sectionDone();

    // --- WATCHLIST ---
    if (watchlistItems.length) {
      const mediaIds = [...new Set(watchlistItems.map((it) => it.matchedMediaId))];
      const existing = await this.chunkedFindManyByIds(mediaIds, (ids) =>
        this.prisma.watchlistItem.findMany({
          where: { userId, mediaId: { in: ids } },
          select: { mediaId: true },
        }),
      );
      const existingSet = new Set(existing.map((w: any) => w.mediaId));

      const rows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of watchlistItems) {
        const mediaId = it.matchedMediaId;
        if (existingSet.has(mediaId)) {
          skipped++;
          continue;
        }
        existingSet.add(mediaId);
        const rowId = randomUUID();
        rows.push({ id: rowId, userId, mediaId });
        auditRows.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'watchlist_items',
          targetRecordId: rowId,
          action: 'created',
        });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (rows.length) {
        await this.prisma.$transaction(
          async (tx) => {
            await this.chunkedCreateMany(tx, 'watchlistItem', rows, true);
            await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
            if (appliedIds.length) {
              await this.chunkedUpdateManyByIds(tx, 'importItem', appliedIds, {
                status: 'APPLIED',
              });
            }
          },
          { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
        );
      }
      created += sectionCreated;
    }
    await sectionDone();

    // --- FAVORITES ---
    if (favoriteItems.length) {
      const mediaIds = [...new Set(favoriteItems.map((it) => it.matchedMediaId))];
      const existing = await this.chunkedFindManyByIds(mediaIds, (ids) =>
        this.prisma.favorite.findMany({
          where: { userId, mediaId: { in: ids } },
          select: { mediaId: true },
        }),
      );
      const existingSet = new Set(existing.map((f: any) => f.mediaId));

      const rows: any[] = [];
      const auditRows: any[] = [];
      const appliedIds: string[] = [];
      let sectionCreated = 0;
      for (const it of favoriteItems) {
        const mediaId = it.matchedMediaId;
        if (existingSet.has(mediaId)) {
          skipped++;
          continue;
        }
        existingSet.add(mediaId);
        const rowId = randomUUID();
        rows.push({ id: rowId, userId, mediaId });
        auditRows.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'favorites',
          targetRecordId: rowId,
          action: 'created',
        });
        appliedIds.push(it.id);
        sectionCreated++;
      }
      if (rows.length) {
        await this.prisma.$transaction(
          async (tx) => {
            await this.chunkedCreateMany(tx, 'favorite', rows, true);
            await this.chunkedCreateMany(tx, 'importAppliedRecord', auditRows);
            if (appliedIds.length) {
              await this.chunkedUpdateManyByIds(tx, 'importItem', appliedIds, {
                status: 'APPLIED',
              });
            }
          },
          { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
        );
      }
      created += sectionCreated;
    }
    await sectionDone();

    // --- LISTS (imported lists: TV Time lists-prod-lists.csv / Trakt lists-lists.json) ---
    created += await this.applyLists(userId, importId, items, source);
    await sectionDone();

    // --- RATINGS / EMOTIONS / COMMENTS ---
    const r = await this.applyRatings(userId, importId, items, source);
    created += r.created;
    skipped += r.skipped;
    await sectionDone();
    const e = await this.applyEmotions(userId, importId, items, source);
    created += e.created;
    skipped += e.skipped;
    await sectionDone();
    const c = await this.applyComments(userId, importId, items, source);
    created += c.created;
    skipped += c.skipped;
    await sectionDone();
    const cv = await this.applyCharacterVotes(userId, importId, items, source);
    created += cv.created;
    skipped += cv.skipped;
    await sectionDone();

    return { created, skipped };
  }

  /** Create/update imported lists idempotently (identity = userId + source + sourceKey). */
  private async applyLists(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
  ): Promise<number> {
    // Legacy migration (runs on every TVTIME confirm): imports predating the
    // favorites-routing fix created CustomLists with sourceKey favorite-series /
    // favorite-movies — those are the user's favorites, not lists. Move their items
    // into real favorites, then delete the pseudo-lists.
    if (source === 'TVTIME') await this.migrateFavoritePseudoLists(userId, importId);

    const listItems = items.filter(
      (it) => it.sourceEntityType === 'LIST' && it.status === 'MATCHED',
    );
    const listItemItems = items.filter(
      (it) => it.sourceEntityType === 'LIST_ITEM' && it.status === 'MATCHED' && it.matchedMediaId,
    );
    if (!listItems.length) return 0;

    const itemsBySource = new Map<string, any[]>();
    for (const it of listItemItems) {
      const key = it.normalizedData?.sourceKey ?? it.rawData?.sourceKey;
      if (!key) continue;
      if (!itemsBySource.has(key)) itemsBySource.set(key, []);
      itemsBySource.get(key)!.push(it);
    }

    let created = 0;
    for (const it of listItems) {
      const norm: any = it.normalizedData ?? {};
      const sourceKey: string = norm.sourceKey ?? it.rawData?.sourceKey;
      const childItems = (itemsBySource.get(sourceKey) ?? []).filter((x) => x.matchedMediaId);

      // Dedupe media within this source list (keep first occurrence's order).
      const seenMedia = new Set<string>();
      const ordered = new Map<string, number>();
      for (const c of childItems) {
        if (seenMedia.has(c.matchedMediaId)) continue;
        seenMedia.add(c.matchedMediaId);
        ordered.set(c.matchedMediaId, Number(c.normalizedData?.order ?? 0));
      }

      await this.prisma.$transaction(
        async (tx) => {
          // Find existing imported list by stable identity (never match by title).
          let list = await tx.customList.findFirst({
            where: { userId, source, sourceKey },
          });
          let listAudit: any[] = [];
          if (!list) {
            const listId = randomUUID();
            list = await tx.customList.create({
              data: {
                id: listId,
                userId,
                title: norm.title ?? 'Imported list',
                description: norm.description ?? null,
                visibility: norm.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
                source,
                sourceKey,
                ...(norm.createdAt ? { createdAt: new Date(norm.createdAt) } : {}),
              },
            });
            listAudit.push({
              id: randomUUID(),
              importId,
              importItemId: it.id,
              targetTable: 'custom_lists',
              targetRecordId: listId,
              action: 'created',
            });
          } else {
            const prev = {
              title: list.title,
              description: list.description,
              visibility: list.visibility,
            };
            list = await tx.customList.update({
              where: { id: list.id },
              data: {
                title: norm.title ?? list.title,
                description: norm.description ?? list.description,
                visibility: norm.visibility === 'PUBLIC' ? 'PUBLIC' : 'PRIVATE',
              },
            });
            listAudit.push({
              id: randomUUID(),
              importId,
              importItemId: it.id,
              targetTable: 'custom_lists',
              targetRecordId: list.id,
              action: 'updated',
              previousData: prev as any,
              newData: {
                title: list.title,
                description: list.description,
                visibility: list.visibility,
              } as any,
            });
          }

          // Add missing items (skipDuplicates respects @@unique([listId, mediaId])).
          const existingItems = await tx.customListItem.findMany({
            where: { listId: list.id, mediaId: { in: [...ordered.keys()] } },
            select: { mediaId: true },
          });
          const have = new Set(existingItems.map((i: any) => i.mediaId));
          const newRows: any[] = [];
          const itemAudit: any[] = [];
          let order = 0;
          for (const [mediaId, srcOrder] of ordered.entries()) {
            if (have.has(mediaId)) continue;
            const rowId = randomUUID();
            newRows.push({ id: rowId, listId: list.id, mediaId, order: srcOrder ?? order });
            itemAudit.push({
              id: randomUUID(),
              importId,
              importItemId: it.id,
              targetTable: 'custom_list_items',
              targetRecordId: rowId,
              action: 'created',
            });
            created++;
            order++;
          }
          if (newRows.length) await this.chunkedCreateMany(tx, 'customListItem', newRows);
          const allAudit = [...listAudit, ...itemAudit];
          if (allAudit.length) await this.chunkedCreateMany(tx, 'importAppliedRecord', allAudit);
          // Mark the LIST + its applied LIST_ITEMs as APPLIED (idempotent retry).
          const appliedIds = [it.id, ...childItems.map((c) => c.id)];
          await tx.importItem.updateMany({
            where: { id: { in: appliedIds } },
            data: { status: 'APPLIED' },
          });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    }
    return created;
  }

  /**
   * Legacy cleanup: imports predating the favorites-routing fix created CustomLists with
   * sourceKey favorite-series / favorite-movies — those are the user's favorites, not
   * lists. Migrate every item into a real Favorite row (deduped by mediaId), then delete
   * the pseudo-lists (items cascade). Idempotent: once migrated, no pseudo-lists remain.
   */
  private async migrateFavoritePseudoLists(userId: string, importId: string): Promise<void> {
    const pseudo = await this.prisma.customList.findMany({
      where: {
        userId,
        source: 'TVTIME',
        sourceKey: { in: ['favorite-series', 'favorite-movies'] },
      },
      include: { items: { select: { mediaId: true } } },
    });
    if (!pseudo.length) return;

    const mediaIds = [
      ...new Set(pseudo.flatMap((l) => l.items.map((i: any) => i.mediaId as string))),
    ];
    const existing = await this.prisma.favorite.findMany({
      where: { userId, mediaId: { in: mediaIds } },
      select: { mediaId: true },
    });
    const have = new Set(existing.map((f: any) => f.mediaId as string));
    const rows: any[] = [];
    const audit: any[] = [];
    for (const mediaId of mediaIds) {
      if (have.has(mediaId)) continue;
      have.add(mediaId);
      const rowId = randomUUID();
      rows.push({ id: rowId, userId, mediaId });
      audit.push({
        id: randomUUID(),
        importId,
        targetTable: 'favorites',
        targetRecordId: rowId,
        action: 'created',
      });
    }
    await this.prisma.$transaction(async (tx) => {
      if (rows.length) {
        await this.chunkedCreateMany(tx, 'favorite', rows, true);
        await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
      }
      await tx.customList.deleteMany({ where: { id: { in: pseudo.map((l) => l.id) } } });
    });
    this.logger.log(
      `Import ${importId}: migrated ${rows.length} favorite(s) from ${pseudo.length} legacy favorite-* pseudo-list(s) and deleted them`,
    );
  }

  /** Apply ratings with a non-destructive conflict policy (never overwrite manual ratings). */
  private async applyRatings(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
  ): Promise<{ created: number; skipped: number }> {
    const ratingItems = items.filter(
      (it) =>
        ['EPISODE_RATING', 'MOVIE_RATING', 'SHOW_RATING'].includes(it.sourceEntityType) &&
        it.status === 'MATCHED',
    );
    if (!ratingItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;

    const epIds = [
      ...new Set(ratingItems.map((it: any) => it.matchedEpisodeId).filter(Boolean)),
    ] as string[];
    const mediaIds = [
      ...new Set(ratingItems.map((it: any) => it.matchedMediaId).filter(Boolean)),
    ] as string[];
    const [existingEp, existingMedia] = await Promise.all([
      epIds.length
        ? this.prisma.rating.findMany({ where: { userId, episodeId: { in: epIds } } })
        : [],
      mediaIds.length
        ? this.prisma.rating.findMany({ where: { userId, mediaId: { in: mediaIds } } })
        : [],
    ]);
    const epMap = new Map(existingEp.map((r: any) => [r.episodeId, r]));
    const mediaMap = new Map(existingMedia.map((r: any) => [r.mediaId, r]));

    const toCreate: any[] = [];
    const audit: any[] = [];
    const updates: { id: string; rating: number }[] = [];
    const updateAudit: any[] = [];
    const appliedIds: string[] = [];

    for (const it of ratingItems) {
      const norm: any = it.normalizedData ?? {};
      const rating = Number(norm.normalizedRating);
      if (!Number.isFinite(rating)) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      const sourceKey =
        norm.voteKey ??
        (it.matchedEpisodeId ? `episode:${it.matchedEpisodeId}` : `media:${it.matchedMediaId}`);
      const existing: any = it.matchedEpisodeId
        ? epMap.get(it.matchedEpisodeId)
        : mediaMap.get(it.matchedMediaId);
      if (!existing) {
        const id = randomUUID();
        // Episode ratings key on episodeId only (mediaId null) so multiple episodes of the
        // same show don't collide on the @@unique([userId, mediaId]) constraint.
        const isEpisode = !!it.matchedEpisodeId;
        toCreate.push({
          id,
          userId,
          episodeId: isEpisode ? it.matchedEpisodeId : null,
          mediaId: isEpisode ? null : (it.matchedMediaId ?? null),
          rating,
          source,
          sourceKey,
          createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
          updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : new Date(),
        });
        audit.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'ratings',
          targetRecordId: id,
          action: 'created',
        });
        appliedIds.push(it.id);
        created++;
      } else if (existing.source === source && existing.sourceKey === sourceKey) {
        // idempotent update of the same imported record
        updates.push({ id: existing.id, rating });
        updateAudit.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'ratings',
          targetRecordId: existing.id,
          action: 'updated',
          previousData: { rating: existing.rating } as any,
          newData: { rating } as any,
        });
        appliedIds.push(it.id);
        created++;
      } else {
        // conflict: local rating exists (manual or different source) — never overwrite
        skipped++;
        appliedIds.push(it.id);
      }
    }

    if (toCreate.length || updates.length) {
      await this.prisma.$transaction(
        async (tx) => {
          if (toCreate.length) await this.chunkedCreateMany(tx, 'rating', toCreate, true);
          for (const u of updates) {
            await tx.rating.update({
              where: { id: u.id },
              data: { rating: u.rating, updatedAt: new Date() },
            });
          }
          await this.chunkedCreateMany(tx, 'importAppliedRecord', [...audit, ...updateAudit]);
          if (appliedIds.length)
            await tx.importItem.updateMany({
              where: { id: { in: appliedIds } },
              data: { status: 'APPLIED' },
            });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: appliedIds } },
        data: { status: 'APPLIED' },
      });
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: {
        ratingsImported: { increment: created },
        ratingsUpdated: { increment: updates.length },
      },
    });
    return { created, skipped };
  }

  /** Apply emotions additively (never remove existing; idempotent via unique constraints). */
  private async applyEmotions(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
  ): Promise<{ created: number; skipped: number }> {
    const emotionItems = items.filter(
      (it) =>
        ['EPISODE_EMOTION', 'MOVIE_EMOTION'].includes(it.sourceEntityType) &&
        it.status === 'MATCHED',
    );
    if (!emotionItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;

    const epIds = [
      ...new Set(emotionItems.map((it: any) => it.matchedEpisodeId).filter(Boolean)),
    ] as string[];
    const mediaIds = [
      ...new Set(emotionItems.map((it: any) => it.matchedMediaId).filter(Boolean)),
    ] as string[];
    const [existingEp, existingMedia] = await Promise.all([
      epIds.length
        ? this.prisma.reaction.findMany({
            where: { userId, episodeId: { in: epIds } },
            select: { episodeId: true, reaction: true },
          })
        : [],
      mediaIds.length
        ? this.prisma.reaction.findMany({
            where: { userId, mediaId: { in: mediaIds } },
            select: { mediaId: true, reaction: true },
          })
        : [],
    ]);
    const haveEp = new Set(existingEp.map((r: any) => `${r.episodeId}|${r.reaction}`));
    const haveMedia = new Set(existingMedia.map((r: any) => `${r.mediaId}|${r.reaction}`));

    const rows: any[] = [];
    const audit: any[] = [];
    const appliedIds: string[] = [];

    for (const it of emotionItems) {
      const norm: any = it.normalizedData ?? {};
      const reaction = norm.normalizedEmotion;
      if (!reaction) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      const isEp = !!it.matchedEpisodeId;
      const key = isEp ? `${it.matchedEpisodeId}|${reaction}` : `${it.matchedMediaId}|${reaction}`;
      const have = isEp ? haveEp.has(key) : haveMedia.has(key);
      if (have) {
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      if (isEp) haveEp.add(key);
      else haveMedia.add(key);
      const id = randomUUID();
      rows.push({
        id,
        userId,
        episodeId: isEp ? it.matchedEpisodeId : null,
        mediaId: isEp ? null : it.matchedMediaId,
        reaction,
        source,
        sourceKey: norm.voteKey ?? key,
        createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
        updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : null,
      });
      audit.push({
        id: randomUUID(),
        importId,
        importItemId: it.id,
        targetTable: 'reactions',
        targetRecordId: id,
        action: 'created',
      });
      appliedIds.push(it.id);
      created++;
    }

    if (rows.length) {
      await this.prisma.$transaction(
        async (tx) => {
          await this.chunkedCreateMany(tx, 'reaction', rows, true);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
          if (appliedIds.length)
            await tx.importItem.updateMany({
              where: { id: { in: appliedIds } },
              data: { status: 'APPLIED' },
            });
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: appliedIds } },
        data: { status: 'APPLIED' },
      });
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: { emotionsImported: { increment: created } },
    });
    return { created, skipped };
  }

  /**
   * Apply episode and movie favorite-character votes with local, batched identity lookup.
   * Episode targets use their staged canonical episode. Movie targets use a title-scoped
   * TVDB role alias, falling back to the legacy media_cast.characterExternalId column.
   * Shows whose cast predates the field are queued for one scoped background TVDB cast
   * refresh (BullMQ, deduped, retried with backoff). Completed imports replay
   * automatically after refresh; a character still absent then is audited SKIPPED.
   * Conflict policy mirrors ratings: create only when no vote exists; idempotent re-import
   * via (source, sourceKey); manual votes are NEVER overwritten. Historical createdAt kept.
   */
  private async applyCharacterVotes(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
    opts: {
      enqueueMissing?: boolean;
      terminalUnresolved?: boolean;
      countUnresolved?: boolean;
      /** Internal one-shot retry after a concurrent structure/cast rewrite invalidates an FK. */
      retryForeignKeyRace?: boolean;
    } = {},
  ): Promise<{ created: number; skipped: number }> {
    let voteItems = items.filter(
      (it) =>
        (it.sourceEntityType === 'EPISODE_CHARACTER_VOTE' ||
          it.sourceEntityType === 'MOVIE_CHARACTER_VOTE') &&
        (it.status === 'MATCHED' || it.status === 'PENDING_MATCH') &&
        it.matchedMediaId &&
        (it.sourceEntityType === 'MOVIE_CHARACTER_VOTE' || it.matchedEpisodeId),
    );
    if (!voteItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;
    let unresolved = 0;

    // Structure consolidation can replace an episode after an import item was staged while
    // leaving that item pending for a later cast refresh. Never insert a character vote using
    // the stale FK. Resolve the active canonical episode locally by the imported TVDB episode
    // alias first; regular episodes may then use an unambiguous S/E fallback inside the already
    // verified show. Specials remain exact-id only.
    const episodeVoteItems = voteItems.filter(
      (item: any) => item.sourceEntityType === 'EPISODE_CHARACTER_VOTE',
    );
    const stagedEpisodeIds = [
      ...new Set(episodeVoteItems.map((it: any) => it.matchedEpisodeId as string)),
    ];
    const activeEpisodes = await this.prisma.episode.findMany({
      where: { id: { in: stagedEpisodeIds }, structureState: 'ACTIVE' },
      select: { id: true, season: { select: { show: { select: { mediaId: true } } } } },
    });
    const activeEpisodeMedia = new Map(
      activeEpisodes.map((episode: any) => [episode.id, episode.season.show.mediaId]),
    );
    const repairedEpisodeItems: any[] = [];
    const missingEpisodeItems: any[] = [];

    for (const item of episodeVoteItems) {
      if (activeEpisodeMedia.get(item.matchedEpisodeId) === item.matchedMediaId) continue;

      const normalized: any = item.normalizedData ?? {};
      const externalEpisodeId = normalized.externalEpisodeId;
      const exactAlias =
        externalEpisodeId != null
          ? await this.prisma.episodeExternalId.findFirst({
              where: {
                provider: 'THE_TVDB',
                providerEntityKind: 'EPISODE',
                value: String(externalEpisodeId),
                episode: {
                  structureState: 'ACTIVE',
                  season: { show: { mediaId: item.matchedMediaId } },
                },
              },
              select: { episodeId: true },
            })
          : null;

      let replacementId = exactAlias?.episodeId ?? null;
      const seasonNumber = Number(normalized.seasonNumber);
      const episodeNumber = Number(normalized.episodeNumber);
      if (
        !replacementId &&
        Number.isInteger(seasonNumber) &&
        seasonNumber > 0 &&
        Number.isInteger(episodeNumber) &&
        episodeNumber > 0
      ) {
        const replacements = await this.prisma.episode.findMany({
          where: {
            structureState: 'ACTIVE',
            season: { show: { mediaId: item.matchedMediaId }, number: seasonNumber },
            number: episodeNumber,
          },
          select: { id: true },
          take: 2,
        });
        replacementId = replacements.length === 1 ? replacements[0].id : null;
      }

      if (replacementId) {
        this.logger.warn(
          `character-vote replay: remapped stale episode ${item.matchedEpisodeId} to ${replacementId} for import item ${item.id}`,
        );
        item.matchedEpisodeId = replacementId;
        repairedEpisodeItems.push(item);
      } else {
        this.logger.warn(
          `character-vote replay: skipping import item ${item.id} because episode ${item.matchedEpisodeId} has no unambiguous active canonical replacement`,
        );
        missingEpisodeItems.push(item);
      }
    }

    if (repairedEpisodeItems.length) {
      await Promise.all(
        repairedEpisodeItems.map((item) =>
          this.prisma.importItem.update({
            where: { id: item.id },
            data: { matchedEpisodeId: item.matchedEpisodeId, errorMessage: null },
          }),
        ),
      );
    }
    if (missingEpisodeItems.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: missingEpisodeItems.map((item) => item.id) } },
        data: {
          status: 'SKIPPED',
          matchedEpisodeId: null,
          errorMessage: 'Episode has no unambiguous active canonical replacement',
        },
      });
      skipped += missingEpisodeItems.length;
      const missingIds = new Set(missingEpisodeItems.map((item) => item.id));
      voteItems = voteItems.filter((item) => !missingIds.has(item.id));
      if (!voteItems.length) return { created, skipped };
    }

    const mediaIds = [...new Set(voteItems.map((it: any) => it.matchedMediaId as string))];
    const charIds = [
      ...new Set(
        voteItems
          .map((it: any) => Number(it.normalizedData?.showCharacterId))
          .filter((n) => Number.isFinite(n) && n > 0),
      ),
    ];

    const castKey = (mediaId: string, charId: number) => `${mediaId}:${charId}`;
    const castMap = new Map<string, string>();
    const loadCastRows = async () => {
      const [aliases, legacyRows] = await Promise.all([
        this.prisma.mediaCastExternalId.findMany({
          where: {
            mediaId: { in: mediaIds },
            provider: 'THE_TVDB',
            value: { in: charIds.map(String) },
          },
          select: { mediaId: true, value: true, castId: true },
        }),
        this.prisma.mediaCast.findMany({
          where: { mediaId: { in: mediaIds }, characterExternalId: { in: charIds } },
          select: { id: true, mediaId: true, characterExternalId: true },
        }),
      ]);
      for (const alias of aliases) {
        castMap.set(castKey(alias.mediaId, Number(alias.value)), alias.castId);
      }
      for (const row of legacyRows) {
        const key = castKey(row.mediaId, row.characterExternalId!);
        if (!castMap.has(key)) castMap.set(key, row.id);
      }
      return aliases.length + legacyRows.length;
    };
    await loadCastRows();

    // Shows whose cast lacks the needed character ids: enqueue ONE background TVDB
    // re-hydration per show (stable job id dedupes) — never block the import on TVDB.
    // Their votes stay pending below and replay automatically after the cast refresh.
    const missingMediaIds = [
      ...new Set(
        voteItems
          .filter(
            (it: any) =>
              !castMap.has(castKey(it.matchedMediaId, Number(it.normalizedData?.showCharacterId))),
          )
          .map((it: any) => it.matchedMediaId as string),
      ),
    ];
    if (opts.enqueueMissing !== false) {
      const mediaTypes = await this.prisma.mediaItem.findMany({
        where: { id: { in: missingMediaIds } },
        select: { id: true, type: true },
      });
      for (const media of mediaTypes) {
        if (media.type === 'MOVIE') {
          await this.hydration.enqueueTvdbMovieCastEnrichment(media.id).catch(() => undefined);
        } else {
          await this.enqueueShowTvdbHydration(media.id).catch(() => undefined);
        }
      }
    }

    const epIds = [
      ...new Set(
        voteItems
          .filter((it: any) => it.sourceEntityType === 'EPISODE_CHARACTER_VOTE')
          .map((it: any) => it.matchedEpisodeId as string),
      ),
    ];
    const movieIds = [
      ...new Set(
        voteItems
          .filter((it: any) => it.sourceEntityType === 'MOVIE_CHARACTER_VOTE')
          .map((it: any) => it.matchedMediaId as string),
      ),
    ];
    const existingVotes = await this.prisma.characterVote.findMany({
      where: {
        userId,
        OR: [
          ...(epIds.length ? [{ episodeId: { in: epIds } }] : []),
          ...(movieIds.length ? [{ mediaId: { in: movieIds } }] : []),
        ],
      },
    });
    const voteTargetKey = (item: any) =>
      item.sourceEntityType === 'MOVIE_CHARACTER_VOTE'
        ? `movie:${item.matchedMediaId}`
        : `episode:${item.matchedEpisodeId}`;
    const voteMap = new Map(
      existingVotes.map((vote: any) => [
        vote.mediaId ? `movie:${vote.mediaId}` : `episode:${vote.episodeId}`,
        vote,
      ]),
    );

    const toCreate: any[] = [];
    const audit: any[] = [];
    const appliedIds: string[] = [];
    const pendingMatchIds: string[] = [];

    for (const it of voteItems) {
      const norm: any = it.normalizedData ?? {};
      const charId = Number(norm.showCharacterId);
      const sourceKey: string = norm.voteKey ?? `episode:${norm.externalEpisodeId}:char:${charId}`;
      const castId = castMap.get(castKey(it.matchedMediaId, charId));
      if (!castId) {
        // Not resolvable now (character beyond the top-20 cast, or cast rows predating
        // the field): mark PENDING_MATCH — post-refresh reconciliation applies it.
        // Counted as unresolved once during confirmation.
        unresolved++;
        pendingMatchIds.push(it.id);
        continue;
      }
      const existing: any = voteMap.get(voteTargetKey(it));
      if (!existing) {
        toCreate.push({
          id: randomUUID(),
          userId,
          ...(it.sourceEntityType === 'MOVIE_CHARACTER_VOTE'
            ? { mediaId: it.matchedMediaId }
            : { episodeId: it.matchedEpisodeId }),
          castId,
          source,
          sourceKey,
          createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
        });
        audit.push({
          id: randomUUID(),
          importId,
          importItemId: it.id,
          targetTable: 'character_votes',
          targetRecordId: castId,
          action: 'created',
        });
        appliedIds.push(it.id);
        created++;
      } else {
        // Already voted (manual, same import, or a different character): never overwrite.
        skipped++;
        appliedIds.push(it.id);
      }
    }

    if (toCreate.length) {
      // Guard against concurrent metadata rewrites: a queued tvdb-rehydrate (or the anime
      // cron) can replace media_cast after castMap resolves it, while structure repair can
      // replace an episode after the local canonical check above. Re-validate cast ids inside
      // the transaction; vanished cast ids fall back to PENDING_MATCH. If either FK still
      // races, the whole apply restarts once outside the aborted transaction.
      const validateCastIds = async (tx: any, rows: any[]) => {
        const ids = [...new Set(rows.map((r) => r.castId))];
        const found = await tx.mediaCast.findMany({
          where: { id: { in: ids } },
          select: { id: true },
        });
        return new Set(found.map((f: any) => f.id) as string[]);
      };
      const dropStale = (valid: Set<string>) => {
        const droppedRows = toCreate.filter((r) => !valid.has(r.castId));
        if (!droppedRows.length) return;
        const droppedItemIds = new Set(
          audit.filter((a) => !valid.has(a.targetRecordId)).map((a) => a.importItemId),
        );
        for (let i = toCreate.length - 1; i >= 0; i--) {
          if (!valid.has(toCreate[i].castId)) toCreate.splice(i, 1);
        }
        for (let i = audit.length - 1; i >= 0; i--) {
          if (!valid.has(audit[i].targetRecordId)) audit.splice(i, 1);
        }
        for (let i = appliedIds.length - 1; i >= 0; i--) {
          if (droppedItemIds.has(appliedIds[i])) appliedIds.splice(i, 1);
        }
        pendingMatchIds.push(...droppedItemIds);
        unresolved += droppedItemIds.size;
        created -= droppedItemIds.size;
      };
      try {
        await this.prisma.$transaction(
          async (tx) => {
            dropStale(await validateCastIds(tx, toCreate));
            await this.chunkedCreateMany(tx, 'characterVote', toCreate, true);
            await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
            if (appliedIds.length) {
              await tx.importItem.updateMany({
                where: { id: { in: appliedIds } },
                data: { status: 'APPLIED' },
              });
            }
          },
          { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
        );
      } catch (e: any) {
        if (e?.code !== 'P2003' || opts.retryForeignKeyRace === false) throw e;
        // PostgreSQL marks an interactive transaction aborted as soon as the FK insert
        // fails. Never query/retry inside that transaction (it can only return 25P02).
        // Start the apply once more from scratch so newly rewritten episode/cast ids are
        // resolved and validated in a fresh transaction.
        return this.applyCharacterVotes(userId, importId, items, source, {
          ...opts,
          retryForeignKeyRace: false,
        });
      }
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: appliedIds } },
        data: { status: 'APPLIED' },
      });
    }

    // The initial apply leaves unresolved votes pending while CAST_ONLY hydration runs.
    // A post-refresh reconciliation is terminal: ids still absent after the authoritative
    // TVDB cast snapshot are audited SKIPPED instead of remaining stranded forever.
    if (pendingMatchIds.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: pendingMatchIds } },
        data: opts.terminalUnresolved
          ? {
              status: 'SKIPPED',
              errorMessage: 'TVDB character id not present after cast refresh',
            }
          : { status: 'PENDING_MATCH' },
      });
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: {
        characterVotesImported: { increment: created },
        ...(opts.countUnresolved === false
          ? {}
          : { characterVotesSkippedUnresolved: { increment: unresolved } }),
      },
    });
    return { created, skipped };
  }

  /** Requeue only; confirmation must never execute the provider comparison inline. */
  private async enqueuePendingStructureEvaluations(importId: string): Promise<void> {
    const rows = await this.prisma.importItem.findMany({
      where: {
        importId,
        status: 'PENDING_MATCH',
        errorMessage: STRUCTURE_PENDING_ERROR,
        matchedMediaId: { not: null },
      },
      select: { matchedMediaId: true },
      distinct: ['matchedMediaId'],
    });
    await Promise.all(
      rows.flatMap((row) =>
        row.matchedMediaId ? [this.hydration.enqueueStructureEvaluation(row.matchedMediaId)] : [],
      ),
    );
  }

  private importedTvdbEpisodeId(item: any): string | null {
    const normalized = (item.normalizedData ?? {}) as Record<string, any>;
    const raw = (item.rawData ?? {}) as Record<string, any>;
    const candidates = [
      normalized.externalEpisodeId,
      normalized.episodeIds?.tvdb,
      raw.episodeIds?.tvdb,
      raw.episode_ids?.tvdb,
      raw.episode_id,
      raw.ep_id,
      raw.tvdbEpisodeId,
      raw.tvdb_episode_id,
    ];
    for (const candidate of candidates) {
      const value = normalizeNumericExternalId(candidate);
      if (value) return value;
    }
    return null;
  }

  private importedEpisodeNumbers(item: any): { season: number | null; episode: number | null } {
    const normalized = (item.normalizedData ?? {}) as Record<string, any>;
    const raw = (item.rawData ?? {}) as Record<string, any>;
    const integer = (...values: unknown[]): number | null => {
      const value = values.find(
        (candidate) =>
          candidate != null && (typeof candidate !== 'string' || candidate.trim() !== ''),
      );
      const parsed = Number(value);
      return Number.isInteger(parsed) ? parsed : null;
    };
    return {
      season: integer(normalized.season, normalized.seasonNumber, raw.season, raw.season_number),
      episode: integer(
        normalized.episode,
        normalized.episodeNumber,
        raw.episode,
        raw.episode_number,
      ),
    };
  }

  private importedEpisodeCoordinate(item: any): { season: number; episode: number } | null {
    const { season, episode } = this.importedEpisodeNumbers(item);
    return season != null && season >= 0 && episode != null && episode > 0
      ? { season, episode }
      : null;
  }

  /**
   * Complete the second half of the non-blocking import workflow after the metadata worker
   * has committed an authority decision. Successful migrations rematch from the new ACTIVE
   * graph and auto-apply rows belonging to an already-completed import. When a migration is
   * blocked, exact TVDB aliases that are already safe on the current ACTIVE graph still replay;
   * only rows without one proven target become ordinary NEEDS_REVIEW rows.
   */
  async reconcilePendingStructureItems(payload: {
    mediaId: string;
    evaluated: boolean;
    blocked: boolean;
  }): Promise<{ examined: number; matched: number; needsReview: number; applied: number }> {
    const mediaId = payload?.mediaId;
    if (!mediaId || this.pendingStructureReconcileInflight.has(mediaId)) {
      return { examined: 0, matched: 0, needsReview: 0, applied: 0 };
    }
    this.pendingStructureReconcileInflight.add(mediaId);
    try {
      // Ignore MATCHING/IMPORTING imports. finishProcessing/confirm re-enqueues the stable
      // job after every row is staged, closing both races without holding up the user.
      const items = await this.prisma.importItem.findMany({
        where: {
          // A previous matcher version may already have expanded one show-level block
          // into hundreds of NEEDS_REVIEW rows. Re-evaluation must heal those rows too;
          // otherwise deploying a matcher fix only helps brand-new imports.
          status: { in: ['PENDING_MATCH', 'NEEDS_REVIEW'] },
          errorMessage: { in: [STRUCTURE_PENDING_ERROR, STRUCTURE_REVIEW_ERROR] },
          matchedMediaId: mediaId,
          import: { status: { in: ['READY_FOR_REVIEW', 'COMPLETED'] } },
        },
        include: {
          import: { select: { id: true, userId: true, format: true, status: true } },
        },
      });
      if (!items.length) {
        return { examined: 0, matched: 0, needsReview: 0, applied: 0 };
      }

      const importIds = [...new Set(items.map((item) => item.importId))];
      const episodes = await this.prisma.episode.findMany({
        where: {
          structureState: 'ACTIVE',
          season: { show: { mediaId } },
        },
        select: {
          id: true,
          number: true,
          season: { select: { number: true } },
          externalIds: {
            where: { provider: 'THE_TVDB', providerEntityKind: 'EPISODE' },
            select: { value: true },
          },
        },
      });
      const byTvdb = new Map<string, string[]>();
      const byCoordinate = new Map<string, string[]>();
      for (const episode of episodes) {
        const coordinate = `${episode.season.number}:${episode.number}`;
        byCoordinate.set(coordinate, [...(byCoordinate.get(coordinate) ?? []), episode.id]);
        for (const external of episode.externalIds) {
          byTvdb.set(external.value, [...(byTvdb.get(external.value) ?? []), episode.id]);
        }
      }

      const resolved = new Map<string, { episodeId: string; sourceKey: string }>();
      for (const item of items) {
        const tvdbId = this.importedTvdbEpisodeId(item);
        const coordinate = this.importedEpisodeCoordinate(item);
        const candidates = tvdbId
          ? (byTvdb.get(tvdbId) ?? [])
          : payload.evaluated && !payload.blocked && coordinate && coordinate.season > 0
            ? (byCoordinate.get(`${coordinate.season}:${coordinate.episode}`) ?? [])
            : [];
        if (candidates.length !== 1) continue;
        resolved.set(item.id, {
          episodeId: candidates[0],
          sourceKey: tvdbId
            ? `tvdb:${tvdbId}`
            : `coordinate:${coordinate!.season}:${coordinate!.episode}`,
        });
      }

      // A many-to-one result is exactly the Lost failure we are preventing. Repeated source
      // rows for the same source episode are fine; distinct provider episodes are not.
      const sourcesByTarget = new Map<string, Set<string>>();
      for (const target of resolved.values()) {
        const sources = sourcesByTarget.get(target.episodeId) ?? new Set<string>();
        sources.add(target.sourceKey);
        sourcesByTarget.set(target.episodeId, sources);
      }
      for (const [itemId, target] of resolved) {
        if ((sourcesByTarget.get(target.episodeId)?.size ?? 0) > 1) resolved.delete(itemId);
      }

      const itemsByTarget = new Map<string, any[]>();
      for (const item of items) {
        const target = resolved.get(item.id);
        if (!target) continue;
        item.status = 'MATCHED';
        item.matchedEpisodeId = target.episodeId;
        item.errorMessage = null;
        item.confidenceScore = 0.95;
        const group = itemsByTarget.get(target.episodeId) ?? [];
        group.push(item);
        itemsByTarget.set(target.episodeId, group);
      }
      for (const [episodeId, group] of itemsByTarget) {
        await this.chunkedUpdateManyByIds(
          this.prisma,
          'importItem',
          group.map((item) => item.id),
          {
            status: 'MATCHED',
            matchedEpisodeId: episodeId,
            confidenceScore: 0.95,
            errorMessage: null,
          },
        );
      }
      const unresolved = items.filter((item) => !resolved.has(item.id));
      // E0/missing coordinates are deleted-provider placeholders, not reviewable episode
      // identities. S0 rows remain exact-alias-only. Preserve E0 comment text honestly at the
      // already-proven show level; keep every other unresolved placeholder as an UNMATCHED
      // diagnostic instead of manufacturing a manual-review task.
      const terminalPlaceholders = unresolved.filter((item) => {
        const coordinate = this.importedEpisodeCoordinate(item);
        return !coordinate || coordinate.season === 0;
      });
      const showCommentFallbacks = terminalPlaceholders.filter((item) => {
        const numbers = this.importedEpisodeNumbers(item);
        return (
          item.sourceEntityType === 'EPISODE_COMMENT' &&
          numbers.episode === 0 &&
          !!item.matchedMediaId
        );
      });
      const showCommentFallbackIds = new Set(showCommentFallbacks.map((item) => item.id));
      const terminalUnmatched = terminalPlaceholders.filter(
        (item) => !showCommentFallbackIds.has(item.id),
      );
      const terminalPlaceholderIds = new Set(terminalPlaceholders.map((item) => item.id));
      const needsReviewItems = unresolved.filter((item) => !terminalPlaceholderIds.has(item.id));

      if (showCommentFallbacks.length) {
        for (const item of showCommentFallbacks) {
          item.sourceEntityType = 'SHOW_COMMENT';
          item.targetEntityType = 'SHOW_COMMENT';
          item.status = 'MATCHED';
          item.matchedEpisodeId = null;
          item.confidenceScore = 0.75;
          item.errorMessage = null;
        }
        await this.chunkedUpdateManyByIds(
          this.prisma,
          'importItem',
          showCommentFallbacks.map((item) => item.id),
          {
            sourceEntityType: 'SHOW_COMMENT',
            targetEntityType: 'SHOW_COMMENT',
            status: 'MATCHED',
            matchedEpisodeId: null,
            confidenceScore: 0.75,
            errorMessage: null,
          },
        );
      }
      if (terminalUnmatched.length) {
        await this.chunkedUpdateManyByIds(
          this.prisma,
          'importItem',
          terminalUnmatched.map((item) => item.id),
          {
            status: 'UNMATCHED',
            matchedEpisodeId: null,
            errorMessage: null,
          },
        );
      }
      if (needsReviewItems.length) {
        await this.chunkedUpdateManyByIds(
          this.prisma,
          'importItem',
          needsReviewItems.map((item) => item.id),
          {
            status: 'NEEDS_REVIEW',
            matchedEpisodeId: null,
            errorMessage: STRUCTURE_REVIEW_ERROR,
          },
        );
      }
      for (const importId of importIds) await this.recountImportStatuses(importId);

      let applied = 0;
      const replayMatchedIds = new Set([...resolved.keys(), ...showCommentFallbackIds]);
      const completedGroups = new Map<string, { imp: any; items: any[] }>();
      for (const item of items) {
        if (!replayMatchedIds.has(item.id) || item.import?.status !== 'COMPLETED') continue;
        const group = completedGroups.get(item.importId) ?? { imp: item.import, items: [] };
        group.items.push(item);
        completedGroups.set(item.importId, group);
      }
      for (const [importId, group] of completedGroups) {
        const source: ListSource = group.imp.format === 'trakt' ? 'TRAKT' : 'TVTIME';
        await this.applyBatch(group.imp.userId, importId, group.items, source);
        applied += group.items.length;
        await this.rebuildShowStatuses(group.imp.userId, group.items);
        if (this.redis) {
          await Promise.all([
            this.redis.delByPattern(`watchnext:${group.imp.userId}:*`),
            this.redis.delByPattern(`upcoming:${group.imp.userId}:*`),
            this.redis.delByPattern(`showsprogress:${group.imp.userId}:*`),
            this.redis.delByPattern(`foryou:v3:${group.imp.userId}:*`),
          ]).catch(() => undefined);
        }
        this.events.emit('import.applied', { userId: group.imp.userId });
      }

      this.matcher.clearStructureEvaluationPending(mediaId);
      return {
        examined: items.length,
        matched: replayMatchedIds.size,
        needsReview: needsReviewItems.length,
        applied,
      };
    } finally {
      this.pendingStructureReconcileInflight.delete(mediaId);
    }
  }

  @OnEvent('metadata.structure-evaluated', { async: true })
  async onStructureEvaluated(payload: {
    mediaId?: string;
    evaluated?: boolean;
    blocked?: boolean;
  }): Promise<void> {
    if (!payload?.mediaId) return;
    const result = await this.reconcilePendingStructureItems({
      mediaId: payload.mediaId,
      evaluated: payload.evaluated === true,
      blocked: payload.blocked === true,
    });
    if (result.examined > 0) {
      this.logger.log(
        `Structure import replay for ${payload.mediaId}: ${result.matched} matched, ${result.needsReview} need review, ${result.applied} applied`,
      );
    }
  }

  /**
   * Replay staged character votes after a scoped TVDB cast refresh. This is safe for
   * COMPLETED imports: source identities and CharacterVote uniqueness keep it idempotent,
   * manual/existing votes are never overwritten, and terminal misses retain their audit row.
   */
  async reconcilePendingCharacterVotes(opts: {
    mediaId?: string;
    importId?: string;
    terminalUnresolved?: boolean;
  }): Promise<{ imports: number; created: number; skipped: number }> {
    const scopeKey = opts.mediaId ? `media:${opts.mediaId}` : `import:${opts.importId ?? 'all'}`;
    if (this.pendingVoteReconcileInflight.has(scopeKey)) {
      return { imports: 0, created: 0, skipped: 0 };
    }
    this.pendingVoteReconcileInflight.add(scopeKey);
    try {
      const items = await this.prisma.importItem.findMany({
        where: {
          status: 'PENDING_MATCH',
          sourceEntityType: {
            in: ['EPISODE_CHARACTER_VOTE', 'MOVIE_CHARACTER_VOTE'],
          },
          ...(opts.mediaId ? { matchedMediaId: opts.mediaId } : {}),
          ...(opts.importId ? { importId: opts.importId } : {}),
          import: { status: 'COMPLETED' },
        },
        include: {
          import: { select: { id: true, userId: true, format: true } },
        },
      });
      const grouped = new Map<string, { imp: any; items: any[] }>();
      for (const item of items) {
        const imp = (item as any).import;
        if (!imp?.id || !imp.userId) continue;
        const group = grouped.get(imp.id) ?? { imp, items: [] };
        group.items.push(item);
        grouped.set(imp.id, group);
      }

      let created = 0;
      let skipped = 0;
      for (const { imp, items: groupItems } of grouped.values()) {
        const source: ListSource = imp.format === 'trakt' ? 'TRAKT' : 'TVTIME';
        const result = await this.applyCharacterVotes(imp.userId, imp.id, groupItems, source, {
          enqueueMissing: !opts.terminalUnresolved,
          terminalUnresolved: opts.terminalUnresolved === true,
          // The initial confirmation already counted these as unresolved.
          countUnresolved: false,
        });
        created += result.created;
        skipped += result.skipped;
      }
      return { imports: grouped.size, created, skipped };
    } finally {
      this.pendingVoteReconcileInflight.delete(scopeKey);
    }
  }

  @OnEvent('metadata.cast-refreshed', { async: true })
  async onCastRefreshed(payload: { mediaId?: string }): Promise<void> {
    if (!payload?.mediaId) return;
    const result = await this.reconcilePendingCharacterVotes({
      mediaId: payload.mediaId,
      terminalUnresolved: true,
    });
    if (result.imports > 0) {
      this.logger.log(
        `Character-vote replay for ${payload.mediaId}: ${result.created} created, ${result.skipped} existing across ${result.imports} imports`,
      );
    }
  }

  /** Queue one background TVDB re-hydration for a show (deduped by stable job id). */
  private async enqueueShowTvdbHydration(mediaId: string): Promise<void> {
    const ext = await this.prisma.externalId.findFirst({
      where: { mediaId, provider: 'THE_TVDB', providerEntityKind: 'SERIES' },
      select: { value: true },
    });
    if (ext) await this.hydration.enqueueTvdbRehydrate(mediaId, Number(ext.value));
  }

  /**
   * Apply top-level comments directly via Prisma (bypassing CommentsService) so that NO
   * notifications are sent and the `comment.created` event (badges) is NOT emitted. Only
   * comments not already imported (same source + sourceKey) are created; manual comments
   * (source=null) are never touched. Historical createdAt is preserved.
   *
   * Scope (full thread import): owner-authored AND third-party comments, top-level AND
   * replies. Third-party authors get deterministic shadow accounts (isShadow). A reply
   * whose parent is missing keeps `parentSourceKey` and links when the parent arrives
   * (see reconcileCommentParents — also covers parents imported later by OTHER users).
   */
  private async applyComments(
    userId: string,
    importId: string,
    items: any[],
    source: ListSource = 'TVTIME',
  ): Promise<{ created: number; skipped: number }> {
    const commentItems = items.filter(
      (it) =>
        ['EPISODE_COMMENT', 'MOVIE_COMMENT', 'SHOW_COMMENT'].includes(it.sourceEntityType) &&
        it.status === 'MATCHED',
    );
    if (!commentItems.length) return { created: 0, skipped: 0 };

    let created = 0;
    let skipped = 0;
    const normOf = (it: any) => it.normalizedData ?? {};

    // ---- Authors: owner vs deterministic shadow accounts (batched). ----
    const externalAuthors = [
      ...new Set(
        commentItems
          .filter((it) => !normOf(it).authorIsOwner && normOf(it).sourceAuthorId)
          .map((it) => String(normOf(it).sourceAuthorId)),
      ),
    ];
    const shadowByExternal = new Map<string, string>();
    for (const ext of externalAuthors) {
      shadowByExternal.set(ext, await this.getOrCreateShadowUser(source, ext));
    }
    const authorOf = (norm: any): string =>
      norm.authorIsOwner || !norm.sourceAuthorId
        ? userId
        : shadowByExternal.get(String(norm.sourceAuthorId))!;

    // ---- Dedupe by (source, sourceKey) GLOBALLY. A source comment id identifies ONE
    // comment worldwide: if the real author already imported it (or another user's
    // archive carried it as a blob reply under a shadow), never create a second copy.
    // RECLAIM exception: comments whose author DELETED their account live under a
    // deleted-user ghost — when the same person re-registers and re-imports,
    // their own comments return to them instead of being dropped as duplicates. ----
    const keys = [
      ...new Set(commentItems.map((it: any) => normOf(it).sourceKey).filter(Boolean)),
    ] as string[];
    const existing = keys.length
      ? await this.prisma.comment.findMany({
          where: { source, sourceKey: { in: keys } },
          select: {
            id: true,
            userId: true,
            sourceKey: true,
            user: { select: { email: true, username: true } },
          },
        })
      : [];
    const have = new Set(existing.map((c: any) => c.sourceKey as string));
    const existingByKey = new Map(existing.map((c: any) => [c.sourceKey as string, c]));
    const reclaimByGhost = new Map<string, string[]>();

    // ---- Parents: in-batch creations + DB comments by (source, sourceKey). ----
    // The raw parent reference (parent comment uuid) maps to the parent's staged sourceKey
    // domain — CSV parents are always `tvtime|{uuid}` (Trakt has no replies).
    const parentRefKey = (norm: any): string | null =>
      norm.parentSourceCommentId ? `tvtime|${norm.parentSourceCommentId}` : null;
    const parentKeys = [
      ...new Set(commentItems.map((it: any) => parentRefKey(normOf(it))).filter(Boolean)),
    ] as string[];
    const dbParents = parentKeys.length
      ? await this.prisma.comment.findMany({
          where: { source, sourceKey: { in: parentKeys } },
          select: { id: true, sourceKey: true, depth: true, rootId: true },
        })
      : [];
    const parentByKey = new Map(dbParents.map((p: any) => [p.sourceKey as string, p]));
    const inBatchKeys = new Set(
      commentItems.map((it: any) => normOf(it).sourceKey).filter(Boolean) as string[],
    );

    const rows: any[] = [];
    const audit: any[] = [];
    const appliedIds: string[] = [];
    // Static images (png/jpg) to download + attach AFTER the comment transaction.
    const imageAttachments: { commentId: string; url: string; format: string }[] = [];
    const createdParents: {
      id: string;
      sourceKey: string;
      depth: number;
      rootId: string | null;
    }[] = [];
    const createdByKey = new Map<string, { id: string; depth: number; rootId: string | null }>();
    const replyCountByParent = new Map<string, number>();

    // Emits one comment row (+ audit/image bookkeeping). parent=null with a parentKey →
    // stray reply (linked later by reconcileCommentParents).
    const emit = (
      it: any,
      norm: any,
      parent: { id: string; depth: number; rootId: string | null } | null,
      parentKey: string | null,
    ) => {
      const sourceKey: string | undefined = norm.sourceKey;
      const body: string = norm.text ?? '';
      const image: { url: string; format: string } | null = norm.image ?? null;
      const authorId = authorOf(norm);
      const threadType =
        it.sourceEntityType === 'EPISODE_COMMENT'
          ? 'EPISODE'
          : it.sourceEntityType === 'MOVIE_COMMENT'
            ? 'MOVIE'
            : 'SHOW';
      const threadId: string | null =
        threadType === 'EPISODE' ? it.matchedEpisodeId : it.matchedMediaId;
      const id = randomUUID();
      const depth = parent ? parent.depth + 1 : 0;
      const rootId = parent ? (parent.rootId ?? parent.id) : null;
      rows.push({
        id,
        userId: authorId,
        parentId: parent?.id ?? null,
        depth,
        rootId,
        parentSourceKey: parent ? null : parentKey,
        threadType,
        threadId,
        body,
        // GIFs are stored by URL (tenor/etc.); static images are downloaded + processed below.
        gifUrl: image && image.format === 'gif' ? image.url : null,
        isSpoiler: !!norm.spoiler || (Number(norm.spoilerCount) || 0) >= COMMENT_SPOILER_THRESHOLD,
        spoilerCount: Number(norm.spoilerCount) || 0,
        language: norm.language ?? null,
        source,
        sourceKey: sourceKey ?? null,
        createdAt: norm.sourceCreatedAt ? new Date(norm.sourceCreatedAt) : new Date(),
        updatedAt: norm.sourceUpdatedAt ? new Date(norm.sourceUpdatedAt) : new Date(),
      });
      if (parent) {
        replyCountByParent.set(parent.id, (replyCountByParent.get(parent.id) ?? 0) + 1);
      }
      if (image && image.format !== 'gif') {
        imageAttachments.push({ commentId: id, url: image.url, format: image.format || 'png' });
      }
      if (sourceKey) {
        have.add(sourceKey);
        createdParents.push({ id, sourceKey, depth, rootId });
        createdByKey.set(sourceKey, { id, depth, rootId });
      }
      audit.push({
        id: randomUUID(),
        importId,
        importItemId: it.id,
        targetTable: 'comments',
        targetRecordId: id,
        action: 'created',
      });
      appliedIds.push(it.id);
      created++;
    };

    // Top-level first, then replies in passes so in-batch parents exist before children.
    let pending = [...commentItems];
    for (let pass = 0; pass < 8 && pending.length; pass++) {
      const next: any[] = [];
      for (const it of pending) {
        const norm = normOf(it);
        const sourceKey: string | undefined = norm.sourceKey;
        const body: string = norm.text ?? '';
        const image: { url: string; format: string } | null = norm.image ?? null;
        if (!body.trim() && !image) {
          skipped++;
          appliedIds.push(it.id);
          continue;
        }
        if (sourceKey && have.has(sourceKey)) {
          const existingRow = existingByKey.get(sourceKey);
          // Reclaim only OWNER-authored candidates: blob replies by others (shadow
          // candidates) must never be moved to the importing user.
          if (norm.authorIsOwner && existingRow && isDeletedUserAccount(existingRow.user)) {
            const ids = reclaimByGhost.get(existingRow.userId) ?? [];
            ids.push(existingRow.id);
            reclaimByGhost.set(existingRow.userId, ids);
          } else {
            skipped++;
          }
          appliedIds.push(it.id);
          continue;
        }
        const threadId: string | null =
          it.sourceEntityType === 'EPISODE_COMMENT' ? it.matchedEpisodeId : it.matchedMediaId;
        if (!threadId) {
          skipped++;
          appliedIds.push(it.id);
          continue;
        }

        // Parent linkage (replies): in-batch first, then DB; unknown → stray (linked later).
        const parentKey: string | null = parentRefKey(norm);
        let parent: { id: string; depth: number; rootId: string | null } | null = null;
        if (parentKey) {
          parent = createdByKey.get(parentKey) ?? parentByKey.get(parentKey) ?? null;
          if (!parent && inBatchKeys.has(parentKey)) {
            next.push(it); // the parent is in this batch but not created yet — next pass
            continue;
          }
        }
        emit(it, norm, parent, parentKey);
      }
      pending = next;
    }
    // Leftovers: the parent was staged in this batch but never created (it failed one of
    // the guards above — empty/duplicate/thread-less). Import them as STRAYS so nothing is
    // lost; reconcileCommentParents links them if the parent ever arrives. A TRUE
    // self-cycle (parent == own source key — corrupt source data) is the only skip left.
    for (const it of pending) {
      const norm = normOf(it);
      const parentKey: string | null = parentRefKey(norm);
      const body: string = norm.text ?? '';
      const threadId: string | null =
        it.sourceEntityType === 'EPISODE_COMMENT' ? it.matchedEpisodeId : it.matchedMediaId;
      if (
        !parentKey ||
        parentKey === norm.sourceKey ||
        (!body.trim() && !norm.image) ||
        !threadId
      ) {
        this.logger.warn(
          `Import ${importId}: comment reply skipped — parent cycle detected (row ${it.rowNumber})`,
        );
        skipped++;
        appliedIds.push(it.id);
        continue;
      }
      emit(it, norm, null, parentKey);
    }

    if (rows.length) {
      await this.prisma.$transaction(
        async (tx) => {
          await this.chunkedCreateMany(tx, 'comment', rows);
          await this.chunkedCreateMany(tx, 'importAppliedRecord', audit);
          if (appliedIds.length)
            await tx.importItem.updateMany({
              where: { id: { in: appliedIds } },
              data: { status: 'APPLIED' },
            });
          // Parents' reply tallies (batched increments).
          for (const [parentId, count] of replyCountByParent) {
            await tx.comment.update({
              where: { id: parentId },
              data: { repliesCount: { increment: count } },
            });
          }
        },
        { timeout: TX_TIMEOUT, maxWait: TX_MAXWAIT },
      );
    } else if (appliedIds.length) {
      await this.prisma.importItem.updateMany({
        where: { id: { in: appliedIds } },
        data: { status: 'APPLIED' },
      });
    }

    // Reclaim the owner's comments that survived a previous account deletion under either
    // the legacy shared account or a per-deletion ghost. The old userId guard prevents a
    // concurrent import from stealing an already-reclaimed row. No audit rows are written,
    // so rollback cannot delete these pre-existing comments.
    let reclaimed = 0;
    for (const [ghostUserId, ids] of reclaimByGhost) {
      const moved = await this.prisma.comment.updateMany({
        where: { id: { in: ids }, userId: ghostUserId },
        data: { userId },
      });
      reclaimed += moved.count;
    }
    if (reclaimed) {
      this.logger.log(
        `Import ${importId}: reclaimed ${reclaimed} comment(s) from a previously deleted account`,
      );
    }

    // Link older strays whose parents just arrived (incl. parents imported by OTHER users).
    await this.reconcileCommentParents(createdParents);

    // Attach static images (png/jpg): download + store in MinIO via the comment-image pipeline,
    // SKIPPING moderation (the image already existed on the user's public TV Time account).
    // Fire-and-forget — importFromUrl catches everything internally, so a dead URL or storage
    // error can never freeze or fail the import; images just appear when ready.
    for (const att of imageAttachments) {
      void this.commentImages.importFromUrl(att.commentId, userId, att.url);
    }

    await this.prisma.import.update({
      where: { id: importId },
      data: { commentsImported: { increment: created + reclaimed } },
    });
    return { created: created + reclaimed, skipped };
  }

  /**
   * Shadow-account claiming: when a user's archive reveals THEIR TV Time account id and a
   * deterministic shadow already exists for it (created by OTHER users' comment imports),
   * the shadow's comments become the real user's and the synthetic account is deleted.
   * Collision rule: if the real user already has the same comment (same source+sourceKey —
   * their own archive also contains it), the shadow copy's children are re-pointed to the
   * real comment and the duplicate is dropped. Never logs comment content.
   */
  private async claimShadowAccount(
    userId: string,
    importId: string,
    ownerExternalId: string | null | undefined,
    source: ListSource,
  ): Promise<void> {
    if (source !== 'TVTIME' || !ownerExternalId) return;
    const email = shadowEmail(source, ownerExternalId);
    const shadow = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!shadow || shadow.id === userId) return;

    const shadowComments = await this.prisma.comment.findMany({
      where: { userId: shadow.id, source },
      select: { id: true, sourceKey: true },
    });
    if (shadowComments.length) {
      const keys = shadowComments.map((c: any) => c.sourceKey).filter(Boolean) as string[];
      const mine = keys.length
        ? await this.prisma.comment.findMany({
            where: { userId, source, sourceKey: { in: keys } },
            select: { id: true, sourceKey: true },
          })
        : [];
      const mineByKey = new Map(mine.map((m: any) => [m.sourceKey as string, m.id as string]));
      const dupIds: string[] = [];
      const reassignIds: string[] = [];
      const absorbedParents = new Set<string>();
      for (const c of shadowComments) {
        const realId = c.sourceKey ? mineByKey.get(c.sourceKey) : undefined;
        if (realId) {
          dupIds.push(c.id);
          absorbedParents.add(realId);
          // Re-point the duplicate's children to the real comment before dropping the copy.
          await this.prisma.comment.updateMany({
            where: { parentId: c.id },
            data: { parentId: realId },
          });
        } else {
          reassignIds.push(c.id);
        }
      }
      if (reassignIds.length) {
        await this.prisma.comment.updateMany({
          where: { id: { in: reassignIds } },
          data: { userId },
        });
      }
      if (dupIds.length) {
        await this.prisma.comment.deleteMany({ where: { id: { in: dupIds } } });
      }
      // Recompute reply tallies for real comments that absorbed the duplicates' children.
      for (const realId of absorbedParents) {
        const n = await this.prisma.comment.count({ where: { parentId: realId } });
        await this.prisma.comment.update({ where: { id: realId }, data: { repliesCount: n } });
      }
      this.logger.log(
        `Import ${importId}: claimed shadow ${email} — ${reassignIds.length} comment(s) reassigned, ${dupIds.length} duplicate(s) dropped`,
      );
    }
    try {
      await this.prisma.user.delete({ where: { id: shadow.id } });
    } catch (e) {
      this.logger.warn(
        `Import ${importId}: shadow user cleanup failed for ${email}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Deterministic shadow account for a third-party comment author (shared across imports:
   * the same external id always maps to the same user). Race-safe on the unique email.
   */
  private async getOrCreateShadowUser(source: string, externalAuthorId: string): Promise<string> {
    const email = shadowEmail(source, externalAuthorId);
    const existing = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) return existing.id;
    const base = shadowUsername(`${source}:${externalAuthorId}`);
    for (let i = 0; i < 5; i++) {
      try {
        const u = await this.prisma.user.create({
          data: {
            email,
            username: i === 0 ? base : `${base}${i + 1}`,
            isShadow: true,
            emailVerified: false,
          },
          select: { id: true },
        });
        return u.id;
      } catch (e: any) {
        if (e?.code === 'P2002') {
          const byEmail = await this.prisma.user.findUnique({
            where: { email },
            select: { id: true },
          });
          if (byEmail) return byEmail.id; // concurrent import won the race
          continue; // username collision — retry with a numeric suffix
        }
        throw e;
      }
    }
    const u = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!u) throw new Error(`shadow user creation failed for ${email}`);
    return u.id;
  }

  /**
   * Link stray replies whose parents just arrived: a reply imported before its parent
   * kept `parentSourceKey` (the parent's source comment id) — attach it now and bump the
   * parent's tally. Runs after every comments apply, so a parent imported later (even by
   * a DIFFERENT user) completes threads retroactively.
   * Note: grandchildren of a linked stray keep their stored depth (rare, cosmetic).
   */
  private async reconcileCommentParents(
    createdParents: { id: string; sourceKey: string; depth: number; rootId: string | null }[],
  ): Promise<void> {
    for (const p of createdParents) {
      const strays = await this.prisma.comment.findMany({
        where: { parentSourceKey: p.sourceKey, parentId: null },
        select: { id: true },
      });
      if (!strays.length) continue;
      const rootId = p.rootId ?? p.id;
      await this.prisma.comment.updateMany({
        where: { id: { in: strays.map((s) => s.id) } },
        data: { parentId: p.id, depth: p.depth + 1, rootId },
      });
      await this.prisma.comment.update({
        where: { id: p.id },
        data: { repliesCount: { increment: strays.length } },
      });
    }
  }

  // ---------------- cancel / rollback / delete ----------------
  async cancel(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (
      ![
        'UPLOADED',
        'QUEUED',
        'EXTRACTING',
        'PARSING',
        'NORMALIZING',
        'MATCHING',
        'READY_FOR_REVIEW',
      ].includes(imp.status)
    ) {
      throw new BadRequestException('Import cannot be cancelled at this stage');
    }
    return this.prisma.import.update({
      where: { id: importId },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });
  }

  async rollback(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (!['COMPLETED', 'IMPORTING'].includes(imp.status)) {
      throw new BadRequestException('Only completed imports can be rolled back');
    }
    const applied = await this.prisma.importAppliedRecord.findMany({
      where: { importId, action: { in: ['created', 'updated'] } },
    });
    // Reverse created records (best-effort). Group by table for targeted deletes.
    const byTable = new Map<string, string[]>();
    const updated = applied.filter((a) => a.action === 'updated');
    for (const a of applied.filter((a) => a.action === 'created')) {
      if (!byTable.has(a.targetTable)) byTable.set(a.targetTable, []);
      byTable.get(a.targetTable)!.push(a.targetRecordId);
    }
    const tableToModel: Record<
      string,
      | 'watchHistory'
      | 'userEpisodeStatus'
      | 'userMovieStatus'
      | 'watchlistItem'
      | 'favorite'
      | 'customList'
      | 'customListItem'
      | 'rating'
      | 'reaction'
      | 'comment'
    > = {
      watch_history: 'watchHistory',
      user_episode_status: 'userEpisodeStatus',
      user_movie_status: 'userMovieStatus',
      watchlist_items: 'watchlistItem',
      favorites: 'favorite',
      custom_lists: 'customList',
      custom_list_items: 'customListItem',
      ratings: 'rating',
      reactions: 'reaction',
      comments: 'comment',
    };
    // Delete children before parents (cascade-safe ordering); best-effort. Comments are
    // self-referential but imported ones have parentId=null, so their position is safe.
    const order = [
      'watch_history',
      'comments',
      'reactions',
      'ratings',
      'custom_list_items',
      'user_episode_status',
      'user_movie_status',
      'watchlist_items',
      'favorites',
      'custom_lists',
    ];
    for (const table of order) {
      const ids = byTable.get(table);
      const model = tableToModel[table];
      if (model && ids?.length) {
        await (this.prisma[model] as any)
          .deleteMany({ where: { id: { in: ids } } })
          .catch(() => undefined);
      }
    }
    // Restore pre-existing data for records the import updated (action=updated).
    for (const a of updated) {
      if (a.targetTable === 'custom_lists' && a.previousData) {
        await this.prisma.customList
          .update({
            where: { id: a.targetRecordId },
            data: {
              title: (a.previousData as any).title,
              description: (a.previousData as any).description,
              visibility: (a.previousData as any).visibility,
            },
          })
          .catch(() => undefined);
      }
      if (a.targetTable === 'ratings' && a.previousData) {
        await this.prisma.rating
          .update({
            where: { id: a.targetRecordId },
            data: { rating: (a.previousData as any).rating },
          })
          .catch(() => undefined);
      }
    }
    return this.prisma.import.update({
      where: { id: importId },
      data: { status: 'ROLLED_BACK', rolledBackAt: new Date() },
    });
  }

  async remove(userId: string, importId: string) {
    const imp = await this.prisma.import.findFirst({ where: { id: importId, userId } });
    if (!imp) throw new NotFoundException('Import not found');
    if (imp.storageKey) await this.storage.delete(imp.storageKey).catch(() => undefined);
    await this.prisma.import.delete({ where: { id: importId } });
    return { ok: true };
  }

  /** After import, rebuild user_show_status for all affected shows (batched). */
  private async rebuildShowStatuses(userId: string, items: any[]) {
    const showIds = [
      ...new Set(
        items
          .filter((it) => it.sourceEntityType === 'WATCHED_EPISODE' && it.matchedMediaId)
          .map((it) => it.matchedMediaId),
      ),
    ];
    if (!showIds.length) return;

    // Single query: watched count + last watched per show for this user
    const watchedStats = await this.prisma.$queryRaw<
      Array<{ mediaId: string; watchedCount: number; lastWatchedAt: Date | null }>
    >`
      SELECT sh.media_id AS "mediaId", COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
      FROM user_episode_status ues
      JOIN episodes e ON ues.episode_id = e.id
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE ues.user_id = ${userId} AND ues.watched = true
        AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
        AND s.is_special = false
        AND (e.air_date IS NULL OR e.air_date <= NOW())
      GROUP BY sh.media_id
    `;

    // Single query: total episode count per show (excluding specials)
    const totalStats = await this.prisma.$queryRaw<Array<{ mediaId: string; totalCount: number }>>`
      SELECT sh.media_id AS "mediaId", COUNT(e.id)::int AS "totalCount"
      FROM episodes e
      JOIN seasons s ON e.season_id = s.id
      JOIN shows sh ON s.show_id = sh.id
      WHERE e.structure_state = 'ACTIVE'::"EpisodeStructureState"
        AND s.is_special = false AND sh.media_id IN (${Prisma.join(showIds)})
        AND (e.air_date IS NULL OR e.air_date <= NOW())
      GROUP BY sh.media_id
    `;

    const watchedMap = new Map(watchedStats.map((r) => [r.mediaId, r]));
    const totalMap = new Map(totalStats.map((r) => [r.mediaId, r.totalCount]));

    // Build upsert rows for all shows that have stats
    const upsertTargets = new Set([...watchedMap.keys(), ...showIds]);
    for (const mediaId of upsertTargets) {
      const w = watchedMap.get(mediaId);
      const totalCount = totalMap.get(mediaId) ?? 0;
      const watchedCount = w?.watchedCount ?? 0;
      const lastWatchedAt = w?.lastWatchedAt ?? null;

      await this.prisma.userShowStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: { userId, mediaId, watchedCount, totalCount, lastWatchedAt },
        update: { watchedCount, totalCount, lastWatchedAt },
      });
    }
  }
}
