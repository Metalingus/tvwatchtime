import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AdmZip from 'adm-zip';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

const EXPORT_REUSE_MS = 60 * 60 * 1000;
const EXPORT_LOCK_TTL_SECONDS = 10 * 60;
const EXPORT_FAILURE_COOLDOWN_SECONDS = 30;

type ExportRequestResult = {
  downloadUrl: string;
  expiresAt: string;
  reused: boolean;
};

type TraktIds = {
  trakt?: number;
  tmdb?: number;
  tvdb?: number;
  imdb?: string;
};

const MEDIA_SELECT = {
  id: true,
  type: true,
  title: true,
  externalIds: {
    select: { provider: true, providerEntityKind: true, value: true, url: true },
  },
  show: { select: { yearStart: true, yearEnd: true } },
  movie: { select: { releaseYear: true, runtimeMinutes: true } },
} as const;

const EPISODE_SELECT = {
  id: true,
  title: true,
  number: true,
  absoluteNumber: true,
  runtimeMinutes: true,
  airDate: true,
  externalIds: {
    select: { provider: true, providerEntityKind: true, value: true, url: true },
  },
  season: {
    select: {
      number: true,
      title: true,
      isSpecial: true,
      show: { select: { media: { select: MEDIA_SELECT } } },
    },
  },
} as const;

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

const json = (value: unknown): Buffer =>
  Buffer.from(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item), 2),
    'utf8',
  );

const numericId = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Convert the app's normalized provider identities into Trakt's portable `ids` object. */
export function toTraktIds(externalIds: any[] | null | undefined): TraktIds {
  const ids: TraktIds = {};
  for (const externalId of externalIds ?? []) {
    if (externalId.provider === 'TMDB') {
      const value = numericId(externalId.value);
      if (value != null) ids.tmdb = value;
    } else if (externalId.provider === 'THE_TVDB') {
      const value = numericId(externalId.value);
      if (value != null) ids.tvdb = value;
    } else if (externalId.provider === 'TRAKT') {
      const value = numericId(externalId.value);
      if (value != null) ids.trakt = value;
    } else if (externalId.provider === 'IMDB' && externalId.value) {
      ids.imdb = String(externalId.value);
    }
  }
  return ids;
}

const traktMedia = (media: any) => ({
  title: media.title,
  year:
    media.type === 'SHOW' ? (media.show?.yearStart ?? null) : (media.movie?.releaseYear ?? null),
  ids: toTraktIds(media.externalIds),
});

const traktEpisode = (episode: any) => ({
  season: episode.season.number,
  number: episode.number,
  title: episode.title,
  ids: toTraktIds(episode.externalIds),
});

const fullMedia = (media: any) => ({
  tvwatchtimeId: media.id,
  type: media.type,
  title: media.title,
  year:
    media.type === 'SHOW' ? (media.show?.yearStart ?? null) : (media.movie?.releaseYear ?? null),
  ids: toTraktIds(media.externalIds),
  externalIds: media.externalIds,
});

const fullEpisode = (episode: any) => ({
  tvwatchtimeId: episode.id,
  title: episode.title,
  season: episode.season.number,
  number: episode.number,
  absoluteNumber: episode.absoluteNumber,
  runtimeMinutes: episode.runtimeMinutes,
  airDate: iso(episode.airDate),
  ids: toTraktIds(episode.externalIds),
  externalIds: episode.externalIds,
  show: fullMedia(episode.season.show.media),
});

/**
 * Build a Trakt-shaped GDPR archive plus a lossless TVWatchTime-specific snapshot.
 * The standard files can be fed back through the current Trakt importer; the supplemental
 * file preserves app concepts Trakt has no representation for.
 */
export function buildUserExportArchive(snapshot: any): Buffer {
  const zip = new AdmZip();
  const mediaById = new Map<string, any>(
    snapshot.catalog.media.map((item: any) => [item.id, item]),
  );
  const episodeById = new Map<string, any>(
    snapshot.catalog.episodes.map((item: any) => [item.id, item]),
  );

  let nextPlayId = 1;
  const history: any[] = [];
  const episodePlayCounts = new Map<string, number>();
  const moviePlayCounts = new Map<string, number>();

  const addEpisodePlay = (episode: any, watchedAt: Date | string | null, fallbackMedia?: any) => {
    const show = episode?.season?.show?.media ?? fallbackMedia;
    if (!episode || !show || episode.season?.number == null || episode.number == null) return;
    history.push({
      id: nextPlayId++,
      watched_at: iso(watchedAt) ?? snapshot.exportedAt,
      action: 'watch',
      type: 'episode',
      episode: traktEpisode(episode),
      show: traktMedia(show),
    });
    episodePlayCounts.set(episode.id, (episodePlayCounts.get(episode.id) ?? 0) + 1);
  };

  const addMoviePlay = (media: any, watchedAt: Date | string | null) => {
    if (!media) return;
    history.push({
      id: nextPlayId++,
      watched_at: iso(watchedAt) ?? snapshot.exportedAt,
      action: 'watch',
      type: 'movie',
      movie: traktMedia(media),
    });
    moviePlayCounts.set(media.id, (moviePlayCounts.get(media.id) ?? 0) + 1);
  };

  for (const row of snapshot.tracking.watchHistory) {
    const media = mediaById.get(row.mediaId);
    if (row.mediaType === 'MOVIE') {
      addMoviePlay(media, row.watchedAt);
      continue;
    }
    const episode = row.episodeId ? episodeById.get(row.episodeId) : null;
    if (episode) {
      addEpisodePlay(episode, row.watchedAt, media);
    } else if (media && row.seasonNumber != null && row.episodeNumber != null) {
      history.push({
        id: nextPlayId++,
        watched_at: iso(row.watchedAt) ?? snapshot.exportedAt,
        action: 'watch',
        type: 'episode',
        episode: {
          season: row.seasonNumber,
          number: row.episodeNumber,
          title: null,
          ids: {},
        },
        show: traktMedia(media),
      });
    }
  }

  // Imports intentionally collapse repeat plays into one history row + watchCount. Add only the
  // missing plays; native rewatches already have one row each and therefore are not doubled.
  for (const status of snapshot.tracking.episodeStatuses) {
    if (!status.watched) continue;
    const episode = episodeById.get(status.episodeId);
    const existing = episodePlayCounts.get(status.episodeId) ?? 0;
    const desired = Math.max(1, status.watchCount ?? 1);
    for (let i = existing; i < desired; i += 1) {
      addEpisodePlay(episode, status.watchedAt ?? status.updatedAt ?? status.createdAt);
    }
  }
  for (const status of snapshot.tracking.movieStatuses) {
    if (!status.watched) continue;
    const media = mediaById.get(status.mediaId);
    const existing = moviePlayCounts.get(status.mediaId) ?? 0;
    const desired = Math.max(1, status.watchCount ?? 1);
    for (let i = existing; i < desired; i += 1) {
      addMoviePlay(media, status.watchedAt ?? status.updatedAt ?? status.createdAt);
    }
  }
  history.sort((a, b) => String(a.watched_at).localeCompare(String(b.watched_at)));
  history.forEach((row, index) => (row.id = index + 1));

  const showRatings: any[] = [];
  const episodeRatings: any[] = [];
  const movieRatings: any[] = [];
  for (const rating of snapshot.votes.ratings) {
    const base = {
      rated_at: iso(rating.updatedAt ?? rating.createdAt) ?? snapshot.exportedAt,
      rating: Math.max(1, Math.min(10, Number(rating.rating) * 2)),
    };
    if (rating.episodeId) {
      const episode = episodeById.get(rating.episodeId);
      if (episode) {
        episodeRatings.push({
          ...base,
          type: 'episode',
          episode: traktEpisode(episode),
          show: traktMedia(episode.season.show.media),
        });
      }
    } else if (rating.mediaId) {
      const media = mediaById.get(rating.mediaId);
      if (media?.type === 'SHOW') {
        showRatings.push({ ...base, type: 'show', show: traktMedia(media) });
      } else if (media?.type === 'MOVIE') {
        movieRatings.push({ ...base, type: 'movie', movie: traktMedia(media) });
      }
    }
  }

  const mediaListRow = (item: any, rank: number) => {
    const media = mediaById.get(item.mediaId);
    if (!media) return null;
    const type = media.type === 'SHOW' ? 'show' : 'movie';
    return {
      rank,
      id: rank,
      listed_at: iso(item.createdAt) ?? snapshot.exportedAt,
      type,
      [type]: traktMedia(media),
    };
  };
  const watchlist = snapshot.library.watchlist
    .map((item: any, index: number) => mediaListRow(item, item.priority || index + 1))
    .filter(Boolean);
  const favorites = snapshot.library.favorites
    .map((item: any, index: number) => mediaListRow(item, index + 1))
    .filter(Boolean);
  const lists = snapshot.library.customLists.map((list: any) => ({
    name: list.title,
    description: list.description,
    privacy: list.visibility === 'PUBLIC' ? 'public' : 'private',
    created_at: iso(list.createdAt),
    updated_at: iso(list.updatedAt),
    item_count: list.items.length,
    ids: { slug: `tvwatchtime-${list.id}` },
    items: [...list.items]
      .sort((a: any, b: any) => a.order - b.order)
      .map((item: any) => {
        const media = mediaById.get(item.mediaId);
        if (!media) return null;
        const type = media.type === 'SHOW' ? 'show' : 'movie';
        return {
          listed_at: iso(item.createdAt) ?? list.createdAt,
          type,
          [type]: traktMedia(media),
        };
      })
      .filter(Boolean),
  }));

  const comments = { episodes: [] as any[], shows: [] as any[], movies: [] as any[] };
  for (const comment of snapshot.comments.authored) {
    const base = {
      id: comment.id,
      parent_id: comment.parentId,
      comment: comment.body,
      spoiler: comment.isSpoiler,
      review: false,
      created_at: iso(comment.createdAt),
      updated_at: iso(comment.updatedAt),
    };
    if (comment.threadType === 'EPISODE') {
      const episode = episodeById.get(comment.threadId);
      if (episode) {
        comments.episodes.push({
          ...base,
          episode: traktEpisode(episode),
          show: traktMedia(episode.season.show.media),
        });
      }
    } else if (comment.threadType === 'SHOW') {
      const media = mediaById.get(comment.mediaId ?? comment.threadId);
      if (media) comments.shows.push({ ...base, show: traktMedia(media) });
    } else if (comment.threadType === 'MOVIE') {
      const media = mediaById.get(comment.mediaId ?? comment.threadId);
      if (media) comments.movies.push({ ...base, movie: traktMedia(media) });
    }
  }

  const locale = String(snapshot.account.profile?.languagePreference ?? 'EN')
    .toLowerCase()
    .replace('_', '-');
  const safeLocale = locale === 'system' ? 'en' : locale;
  const supplemental = {
    schemaVersion: 1,
    format: 'tvwatchtime-user-export',
    exportedAt: snapshot.exportedAt,
    account: snapshot.account,
    catalog: {
      media: snapshot.catalog.media.map(fullMedia),
      episodes: snapshot.catalog.episodes.map(fullEpisode),
    },
    tracking: snapshot.tracking,
    library: snapshot.library,
    votes: snapshot.votes,
    comments: snapshot.comments,
    social: snapshot.social,
    notifications: snapshot.notifications,
    achievements: snapshot.achievements,
    imports: snapshot.imports,
    activity: snapshot.activity,
    support: snapshot.support,
    stats: snapshot.stats,
  };

  const files: Record<string, unknown> = {
    'watched-history-1.json': history,
    'ratings-shows.json': showRatings,
    'ratings-episodes.json': episodeRatings,
    'ratings-movies.json': movieRatings,
    'lists-watchlist.json': watchlist,
    'lists-favorites.json': favorites,
    'lists-lists.json': lists,
    'comments-episodes.json': comments.episodes,
    'comments-shows.json': comments.shows,
    'comments-movies.json': comments.movies,
    'user-settings.json': { browsing: { locale: safeLocale } },
    'user-profile.json': {
      username: snapshot.account.username,
      name: snapshot.account.profile?.displayName ?? null,
      about: snapshot.account.profile?.bio ?? null,
      location: snapshot.account.profile?.location ?? null,
      joined_at: iso(snapshot.account.createdAt),
      ids: { slug: snapshot.account.username },
    },
    'tvwatchtime-export.json': supplemental,
  };
  for (const [name, value] of Object.entries(files)) zip.addFile(name, json(value));
  return zip.toBuffer();
}

@Injectable()
export class ExportService {
  private readonly logger = new Logger(ExportService.name);
  private readonly exportDir: string;
  private static readonly RELEASE_LOCK =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
  private static readonly SHORTEN_FAILED_LOCK =
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('EXPIRE', KEYS[1], ARGV[2]) else return 0 end";

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.exportDir = path.join(process.cwd(), 'storage', 'exports');
  }

  async requestExport(userId: string): Promise<ExportRequestResult> {
    const reusable = await this.findReusableExport(userId);
    if (reusable) return this.exportResponse(reusable, true);

    const lockKey = `user-export:${userId}`;
    const lockToken = crypto.randomBytes(24).toString('hex');
    let acquired: string | null;
    try {
      acquired = await this.redis.client.set(
        lockKey,
        lockToken,
        'EX',
        EXPORT_LOCK_TTL_SECONDS,
        'NX',
      );
    } catch {
      // Generating without the distributed lock would make the expensive endpoint spammable.
      throw new ServiceUnavailableException('Data export is temporarily unavailable');
    }
    if (acquired !== 'OK') {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          code: 'EXPORT_IN_PROGRESS',
          message: 'A data export is already being prepared',
          retryAfterSeconds: 30,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let completed = false;
    try {
      // Another replica may have completed between the first lookup and our lock acquisition.
      const afterLock = await this.findReusableExport(userId);
      if (afterLock) {
        completed = true;
        return this.exportResponse(afterLock, true);
      }

      const snapshot = await this.gatherUserData(userId);
      const payload = buildUserExportArchive(snapshot);
      const token = crypto.randomBytes(32).toString('hex');
      const date = new Date().toISOString().slice(0, 10);
      const fileName = `tvwatchtime-export-${date}.zip`;
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const record = await this.prisma.dataExport.create({
        data: {
          userId,
          token,
          fileName,
          contentType: 'application/zip',
          payload,
          status: 'ready',
          expiresAt,
        },
        select: { token: true, expiresAt: true },
      });
      completed = true;
      return this.exportResponse(record, false);
    } finally {
      const script = completed ? ExportService.RELEASE_LOCK : ExportService.SHORTEN_FAILED_LOCK;
      const args = completed ? [lockToken] : [lockToken, String(EXPORT_FAILURE_COOLDOWN_SECONDS)];
      await this.redis.client.eval(script, 1, lockKey, ...args).catch(() => undefined);
    }
  }

  private async findReusableExport(userId: string) {
    const now = new Date();
    return this.prisma.dataExport.findFirst({
      where: {
        userId,
        status: 'ready',
        payload: { not: null },
        expiresAt: { gt: now },
        createdAt: { gte: new Date(now.getTime() - EXPORT_REUSE_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { token: true, expiresAt: true },
    });
  }

  private exportResponse(
    record: { token: string; expiresAt: Date },
    reused: boolean,
  ): ExportRequestResult {
    return {
      downloadUrl: `${this.apiRouteBaseUrl()}/me/export-download?token=${record.token}`,
      expiresAt: record.expiresAt.toISOString(),
      reused,
    };
  }

  private apiRouteBaseUrl(): string {
    const baseUrl = (this.config.get<string>('api.baseUrl') || '').replace(/\/+$/, '');
    return /\/api$/i.test(baseUrl) ? baseUrl : `${baseUrl}/api`;
  }

  async downloadExport(
    token: string,
  ): Promise<{ buffer: Buffer; fileName: string; contentType: string }> {
    const record = await this.prisma.dataExport.findUnique({ where: { token } });
    if (!record || record.status !== 'ready') throw new NotFoundException('Export not found');
    if (record.expiresAt < new Date()) throw new NotFoundException('Export has expired');

    if (record.payload) {
      return {
        buffer: Buffer.from(record.payload),
        fileName: record.fileName,
        contentType: record.contentType,
      };
    }

    // Backward compatibility for exports requested before the shared-payload migration.
    try {
      const buffer = await fs.readFile(path.join(this.exportDir, record.fileName));
      return {
        buffer,
        fileName: 'tvwatchtime-export.json',
        contentType: record.contentType || 'application/json',
      };
    } catch {
      throw new NotFoundException('Export file no longer available');
    }
  }

  async cleanupExpired(): Promise<number> {
    const expired = await this.prisma.dataExport.findMany({
      where: { expiresAt: { lt: new Date() } },
      select: { id: true, fileName: true, contentType: true },
    });
    const removableIds: string[] = [];
    for (const record of expired) {
      if (record.contentType === 'application/zip') {
        removableIds.push(record.id);
        continue;
      }
      try {
        await fs.unlink(path.join(this.exportDir, record.fileName));
        removableIds.push(record.id);
      } catch (error: any) {
        if (error?.code === 'ENOENT') removableIds.push(record.id);
        else this.logger.warn(`Could not delete expired export ${record.id}: ${error?.message}`);
      }
    }
    if (removableIds.length) {
      await this.prisma.dataExport.deleteMany({ where: { id: { in: removableIds } } });
    }
    return removableIds.length;
  }

  /** Remove every export when its owner deletes their account. */
  async deleteForUser(userId: string): Promise<number> {
    const records = await this.prisma.dataExport.findMany({
      where: { userId },
      select: { id: true, fileName: true, contentType: true },
    });
    const removedIds: string[] = [];
    for (const record of records) {
      if (record.contentType === 'application/zip') {
        removedIds.push(record.id);
        continue;
      }
      try {
        await fs.unlink(path.join(this.exportDir, record.fileName));
        removedIds.push(record.id);
      } catch (error: any) {
        if (error?.code === 'ENOENT') removedIds.push(record.id);
        else this.logger.warn(`Could not delete account export ${record.id}: ${error?.message}`);
      }
    }
    if (removedIds.length) {
      await this.prisma.dataExport.deleteMany({ where: { id: { in: removedIds } } });
    }
    return removedIds.length;
  }

  private async gatherUserData(userId: string) {
    const [
      account,
      showStatuses,
      episodeStatuses,
      movieStatuses,
      watchHistory,
      watchlist,
      favorites,
      ratings,
      reactions,
      characterVotes,
      customLists,
      comments,
      commentLikes,
      spoilerReports,
      externalReviewLikes,
      providerAlerts,
      badges,
      imports,
      followsInitiated,
      followsReceived,
      blocks,
      reports,
      listLikes,
      listSubscriptions,
      notifications,
      pushJobs,
      activity,
      statsSummary,
      statsSnapshots,
      contactThreads,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          isSuspended: true,
          emailVerified: true,
          mustChangePassword: true,
          onboardingStatus: true,
          onboardingVersion: true,
          onboardingCompletedAt: true,
          createdAt: true,
          updatedAt: true,
          profile: true,
          authProviders: {
            select: {
              id: true,
              provider: true,
              providerUid: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          devices: {
            select: {
              id: true,
              platform: true,
              appVersion: true,
              timezone: true,
              active: true,
              createdAt: true,
              updatedAt: true,
            },
          },
          notificationPrefs: true,
        },
      }),
      this.prisma.userShowStatus.findMany({ where: { userId } }),
      this.prisma.userEpisodeStatus.findMany({ where: { userId } }),
      this.prisma.userMovieStatus.findMany({ where: { userId } }),
      this.prisma.watchHistory.findMany({ where: { userId }, orderBy: { watchedAt: 'asc' } }),
      this.prisma.watchlistItem.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.favorite.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.rating.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reaction.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.characterVote.findMany({
        where: { userId },
        include: { cast: { include: { castMember: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.customList.findMany({
        where: { userId },
        include: { items: { orderBy: { order: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.comment.findMany({
        where: { userId },
        include: {
          image: {
            select: {
              id: true,
              status: true,
              originalMimeType: true,
              detectedMimeType: true,
              originalSizeBytes: true,
              processedSizeBytes: true,
              thumbnailSizeBytes: true,
              width: true,
              height: true,
              thumbnailWidth: true,
              thumbnailHeight: true,
              blurhash: true,
              moderationFlagged: true,
              moderationDecision: true,
              rejectionReason: true,
              createdAt: true,
              updatedAt: true,
              processedAt: true,
              deletedAt: true,
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.commentLike.findMany({
        where: { userId },
        include: {
          comment: {
            select: {
              id: true,
              userId: true,
              threadType: true,
              threadId: true,
              body: true,
              isSpoiler: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.commentSpoilerReport.findMany({
        where: { userId },
        include: { comment: { select: { id: true, threadType: true, threadId: true } } },
      }),
      this.prisma.externalReviewLike.findMany({
        where: { userId },
        include: { review: true },
      }),
      this.prisma.watchProviderAlert.findMany({ where: { userId } }),
      this.prisma.userBadge.findMany({
        where: { userId },
        include: { badge: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.import
        .findMany({
          where: { userId },
          select: {
            id: true,
            userId: true,
            sourceType: true,
            format: true,
            originalFilename: true,
            status: true,
            totalFiles: true,
            totalRows: true,
            progress: true,
            matchedCount: true,
            unmatchedCount: true,
            duplicateCount: true,
            conflictCount: true,
            invalidCount: true,
            needsReviewCount: true,
            ratingsDetected: true,
            ratingsImported: true,
            ratingsUpdated: true,
            ratingsSkippedUnsupported: true,
            ratingsSkippedUnresolved: true,
            ratingDuplicatesIgnored: true,
            emotionsDetected: true,
            emotionsImported: true,
            emotionsSkippedUnsupported: true,
            emotionsSkippedUnresolved: true,
            emotionDuplicatesIgnored: true,
            commentRowsDetected: true,
            topLevelCommentsDetected: true,
            commentsImported: true,
            commentRepliesSkipped: true,
            commentActivityRowsSkipped: true,
            commentsByOtherUsersSkipped: true,
            commentsSkippedUnresolved: true,
            commentDuplicatesIgnored: true,
            commentsSkippedInvalid: true,
            characterVotesDetected: true,
            characterVotesImported: true,
            characterVotesSkippedUnresolved: true,
            characterVoteDuplicatesIgnored: true,
            characterVotesSkippedInvalid: true,
            locale: true,
            ownerExternalId: true,
            errorMessage: true,
            createdAt: true,
            updatedAt: true,
            processedAt: true,
            completedAt: true,
            cancelledAt: true,
            rolledBackAt: true,
            files: {
              select: {
                id: true,
                filename: true,
                detectedType: true,
                detectedEntityType: true,
                fileSizeBytes: true,
                rowCount: true,
                status: true,
                errorMessage: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
            items: {
              // rawData/normalizedData can contain malformed provider strings that Prisma 5.22
              // cannot convert through N-API. The normalized library data is exported elsewhere.
              select: {
                id: true,
                importFileId: true,
                rowNumber: true,
                sourceEntityType: true,
                targetEntityType: true,
                status: true,
                matchedMediaId: true,
                matchedEpisodeId: true,
                confidenceScore: true,
                userResolution: true,
                errorMessage: true,
                createdAt: true,
                updatedAt: true,
              },
              orderBy: [{ importFileId: 'asc' }, { rowNumber: 'asc' }],
            },
            logs: {
              select: {
                id: true,
                level: true,
                message: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
            applied: {
              // previousData/newData duplicate the current normalized records and can carry the
              // same malformed source JSON, so retain the complete audit identity without blobs.
              select: {
                id: true,
                importItemId: true,
                targetTable: true,
                targetRecordId: true,
                action: true,
                createdAt: true,
              },
              orderBy: { createdAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        })
        .catch((error: any) => {
          // Import staging is supplemental: a legacy row that Prisma cannot decode must never
          // prevent the user from receiving their authoritative normalized library export.
          this.logger.warn(
            `Import audit omitted from user export (${error?.code ?? error?.name ?? 'decode error'})`,
          );
          return [];
        }),
      this.prisma.follow.findMany({
        where: { followerId: userId },
        include: { target: { select: { id: true, username: true, profile: true } } },
      }),
      this.prisma.follow.findMany({
        where: { targetId: userId },
        include: { follower: { select: { id: true, username: true, profile: true } } },
      }),
      this.prisma.block.findMany({
        where: { blockerId: userId },
        include: { blocked: { select: { id: true, username: true } } },
      }),
      this.prisma.report.findMany({ where: { reporterId: userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.listLike.findMany({
        where: { userId },
        include: { list: { select: { id: true, title: true, userId: true } } },
      }),
      this.prisma.listSubscription.findMany({
        where: { userId },
        include: { list: { select: { id: true, title: true, userId: true } } },
      }),
      this.prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.pushNotificationJob.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.activity.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.userStatsSummary.findUnique({ where: { userId } }),
      this.prisma.userStatsSnapshot.findMany({ where: { userId }, orderBy: { takenAt: 'asc' } }),
      this.prisma.contactThread.findMany({
        where: { userId },
        include: { messages: { orderBy: { createdAt: 'asc' } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    if (!account) throw new NotFoundException('User not found');

    const mediaIds = new Set<string>();
    const episodeIds = new Set<string>();
    const addMedia = (id: string | null | undefined) => id && mediaIds.add(id);
    const addEpisode = (id: string | null | undefined) => id && episodeIds.add(id);
    showStatuses.forEach((item) => addMedia(item.mediaId));
    episodeStatuses.forEach((item) => addEpisode(item.episodeId));
    movieStatuses.forEach((item) => addMedia(item.mediaId));
    watchHistory.forEach((item) => {
      addMedia(item.mediaId);
      addEpisode(item.episodeId);
    });
    watchlist.forEach((item) => addMedia(item.mediaId));
    favorites.forEach((item) => addMedia(item.mediaId));
    ratings.forEach((item) => {
      addMedia(item.mediaId);
      addEpisode(item.episodeId);
    });
    reactions.forEach((item) => {
      addMedia(item.mediaId);
      addEpisode(item.episodeId);
    });
    characterVotes.forEach((item) => addEpisode(item.episodeId));
    customLists.forEach((list) => list.items.forEach((item) => addMedia(item.mediaId)));
    comments.forEach((comment) => {
      addMedia(comment.mediaId);
      if (comment.threadType === 'EPISODE') addEpisode(comment.threadId);
      if (comment.threadType === 'SHOW' || comment.threadType === 'MOVIE')
        addMedia(comment.threadId);
    });
    providerAlerts.forEach((item) => addMedia(item.mediaId));
    externalReviewLikes.forEach((item) => {
      addMedia(item.review.mediaId);
      addEpisode(item.review.episodeId);
    });

    const [media, episodes] = await Promise.all([
      mediaIds.size
        ? this.prisma.mediaItem.findMany({
            where: { id: { in: [...mediaIds] } },
            select: MEDIA_SELECT,
          })
        : [],
      episodeIds.size
        ? this.prisma.episode.findMany({
            where: { id: { in: [...episodeIds] } },
            select: EPISODE_SELECT,
          })
        : [],
    ]);

    return {
      exportedAt: new Date().toISOString(),
      account,
      catalog: { media, episodes },
      tracking: { showStatuses, episodeStatuses, movieStatuses, watchHistory },
      library: { watchlist, favorites, customLists, providerAlerts },
      votes: { ratings, reactions, characterVotes },
      comments: {
        authored: comments,
        likes: commentLikes,
        spoilerReports,
        externalReviewLikes,
      },
      social: {
        following: followsInitiated,
        followers: followsReceived,
        blocks,
        reportsFiled: reports,
        listLikes,
        listSubscriptions,
      },
      notifications: { preferences: account.notificationPrefs, notifications, pushJobs },
      achievements: badges,
      imports,
      activity,
      support: contactThreads,
      stats: { summary: statsSummary, snapshots: statsSnapshots },
    };
  }
}
