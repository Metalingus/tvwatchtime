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
import { signAccountRestoreToken } from './lib/restore-token';

const EXPORT_REUSE_MS = 60 * 60 * 1000;
const EXPORT_LOCK_TTL_SECONDS = 10 * 60;
const EXPORT_FAILURE_COOLDOWN_SECONDS = 30;
const EXPORT_FORMAT_VERSION = 5;
const EXPORT_FILE_PREFIX = `tvwatchtime-export-v${EXPORT_FORMAT_VERSION}-`;

type ExportRequestResult = {
  downloadUrl: string;
  expiresAt: string;
  reused: boolean;
};

type PortableIds = {
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
    select: { provider: true, value: true },
  },
  show: { select: { yearStart: true } },
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
    select: { provider: true, value: true },
  },
  season: {
    select: {
      number: true,
      show: { select: { media: { select: MEDIA_SELECT } } },
    },
  },
} as const;

const iso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

const json = (value: unknown): Buffer =>
  Buffer.from(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    'utf8',
  );

const numericId = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

/** Keep only stable provider identities another service can use to match a title. */
export function toPortableIds(externalIds: any[] | null | undefined): PortableIds {
  const ids: PortableIds = {};
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

const appendToMap = (map: Map<string, any[]>, key: string | null | undefined, value: any) => {
  if (!key) return;
  const rows = map.get(key) ?? [];
  rows.push(value);
  map.set(key, rows);
};

const portableComment = (comment: any) => ({
  id: comment.id,
  parentId: comment.parentId,
  text: comment.body,
  source: comment.source ?? null,
  sourceKey: comment.sourceKey ?? null,
  commsUniCommentId: comment.commsUniCommentId ?? null,
  commsUniParentId: comment.commsUniParentId ?? null,
  spoiler: comment.isSpoiler,
  createdAt: iso(comment.createdAt),
  updatedAt: iso(comment.updatedAt),
});

/** Build one compact, normalized media-library file for straightforward third-party imports. */
export function buildUserExportArchive(snapshot: any): Buffer {
  const zip = new AdmZip();
  const showStatuses = new Map<string, any>(
    snapshot.showStatuses.map((item: any) => [item.mediaId, item]),
  );
  const episodeStatuses = new Map<string, any>(
    snapshot.episodeStatuses.map((item: any) => [item.episodeId, item]),
  );
  const movieStatuses = new Map<string, any>(
    snapshot.movieStatuses.map((item: any) => [item.mediaId, item]),
  );
  const watchlist = new Map<string, any>(
    snapshot.watchlist.map((item: any) => [item.mediaId, item]),
  );
  const favorites = new Map<string, any>(
    snapshot.favorites.map((item: any) => [item.mediaId, item]),
  );
  const mediaRatings = new Map<string, any>();
  const episodeRatings = new Map<string, any>();
  const mediaEmotions = new Map<string, any[]>();
  const episodeEmotions = new Map<string, any[]>();
  const mediaComments = new Map<string, any[]>();
  const episodeComments = new Map<string, any[]>();
  const episodeCharacterVotes = new Map<string, any>();
  const movieCharacterVotes = new Map<string, any>();
  for (const item of snapshot.characterVotes) {
    if (item.episodeId) episodeCharacterVotes.set(item.episodeId, item);
    else if (item.mediaId) movieCharacterVotes.set(item.mediaId, item);
  }
  const movieViewDates = new Map<string, any[]>();
  const episodeViewDates = new Map<string, any[]>();
  const legacyEpisodeViews = new Map<string, any>();

  for (const rating of snapshot.ratings) {
    if (rating.episodeId) episodeRatings.set(rating.episodeId, rating);
    else if (rating.mediaId) mediaRatings.set(rating.mediaId, rating);
  }
  for (const emotion of snapshot.reactions) {
    if (emotion.episodeId) appendToMap(episodeEmotions, emotion.episodeId, emotion);
    else appendToMap(mediaEmotions, emotion.mediaId, emotion);
  }
  for (const comment of snapshot.comments) {
    if (comment.threadType === 'EPISODE') {
      appendToMap(episodeComments, comment.threadId, comment);
    } else if (comment.threadType === 'SHOW' || comment.threadType === 'MOVIE') {
      appendToMap(mediaComments, comment.mediaId ?? comment.threadId, comment);
    }
  }
  for (const view of snapshot.watchHistory) {
    if (view.mediaType === 'MOVIE') {
      appendToMap(movieViewDates, view.mediaId, view.watchedAt);
    } else if (view.episodeId) {
      appendToMap(episodeViewDates, view.episodeId, view.watchedAt);
    } else if (view.seasonNumber != null && view.episodeNumber != null) {
      const key = `${view.mediaId}:s${view.seasonNumber}:e${view.episodeNumber}`;
      const existing = legacyEpisodeViews.get(key) ?? {
        id: key,
        showId: view.mediaId,
        season: view.seasonNumber,
        number: view.episodeNumber,
        dates: [],
      };
      existing.dates.push(view.watchedAt);
      legacyEpisodeViews.set(key, existing);
    }
  }

  const ratingFor = (rating: any) =>
    rating
      ? { value: rating.rating, ratedAt: iso(rating.updatedAt ?? rating.createdAt) }
      : undefined;
  const emotionsFor = (rows: any[] | undefined) =>
    rows?.map((row) => ({ value: row.reaction, at: iso(row.updatedAt ?? row.createdAt) })) ?? [];
  const commentsFor = (rows: any[] | undefined) => rows?.map(portableComment) ?? [];
  const characterVoteFor = (vote: any) => {
    if (!vote) return undefined;
    const member = vote.cast?.castMember;
    const roleIds: Record<string, number | string> = {};
    for (const externalId of vote.cast?.externalIds ?? []) {
      if (externalId.provider === 'THE_TVDB') {
        const value = numericId(externalId.value);
        if (value != null) roleIds.tvdb = value;
      }
    }
    if (roleIds.tvdb == null && vote.cast?.characterExternalId != null) {
      roleIds.tvdb = vote.cast.characterExternalId;
    }
    return {
      character: vote.cast?.character ?? null,
      characterIds: roleIds,
      person: member
        ? {
            name: member.name,
            ids: {
              ...(member.tmdbId != null ? { tmdb: member.tmdbId } : {}),
              ...(member.tvdbId != null ? { tvdb: member.tvdbId } : {}),
              ...(member.imdbId ? { imdb: member.imdbId } : {}),
            },
          }
        : null,
      votedAt: iso(vote.createdAt),
    };
  };
  const viewsFor = (status: any, dates: any[] | undefined) => {
    const knownDates = (dates ?? [])
      .map(iso)
      .filter((date): date is string => Boolean(date))
      .sort();
    if (!knownDates.length && status?.watchedAt) knownDates.push(iso(status.watchedAt)!);
    const statusCount = status?.watched ? Math.max(1, status.watchCount ?? 1) : 0;
    const count = Math.max(statusCount, knownDates.length);
    if (!count) return undefined;
    return { count, dates: knownDates, ...(status?.device ? { device: status.device } : {}) };
  };
  const libraryFields = (mediaId: string) => {
    const watchlistItem = watchlist.get(mediaId);
    const favorite = favorites.get(mediaId);
    const rating = ratingFor(mediaRatings.get(mediaId));
    const emotions = emotionsFor(mediaEmotions.get(mediaId));
    const comments = commentsFor(mediaComments.get(mediaId));
    return {
      ...(watchlistItem
        ? {
            watchlisted: {
              addedAt: iso(watchlistItem.createdAt),
              priority: watchlistItem.priority,
            },
          }
        : {}),
      ...(favorite ? { favorite: { addedAt: iso(favorite.createdAt) } } : {}),
      ...(rating ? { rating } : {}),
      ...(emotions.length ? { emotions } : {}),
      ...(comments.length ? { comments } : {}),
    };
  };

  const shows = snapshot.catalog.media
    .filter((media: any) => media.type === 'SHOW')
    .map((media: any) => {
      const status = showStatuses.get(media.id);
      return {
        id: media.id,
        title: media.title,
        year: media.show?.yearStart ?? null,
        ids: toPortableIds(media.externalIds),
        ...libraryFields(media.id),
        ...(status
          ? {
              tracking: {
                watchedEpisodes: status.watchedCount,
                totalEpisodes: status.totalCount,
                lastWatchedAt: iso(status.lastWatchedAt),
                pausedAt: iso(status.pausedAt),
                rewatchStartedAt: iso(status.rewatchStartedAt),
                dropped: status.dropped,
              },
            }
          : {}),
      };
    });

  const movies = snapshot.catalog.media
    .filter((media: any) => media.type === 'MOVIE')
    .map((media: any) => {
      const views = viewsFor(movieStatuses.get(media.id), movieViewDates.get(media.id));
      const characterVote = characterVoteFor(movieCharacterVotes.get(media.id));
      return {
        id: media.id,
        title: media.title,
        year: media.movie?.releaseYear ?? null,
        runtimeMinutes: media.movie?.runtimeMinutes ?? null,
        ids: toPortableIds(media.externalIds),
        ...libraryFields(media.id),
        ...(views ? { views } : {}),
        ...(characterVote ? { characterVote } : {}),
      };
    });

  const episodes: any[] = snapshot.catalog.episodes
    .map((episode: any) => {
      const views = viewsFor(episodeStatuses.get(episode.id), episodeViewDates.get(episode.id));
      const rating = ratingFor(episodeRatings.get(episode.id));
      const emotions = emotionsFor(episodeEmotions.get(episode.id));
      const comments = commentsFor(episodeComments.get(episode.id));
      const characterVote = characterVoteFor(episodeCharacterVotes.get(episode.id));
      const hasUserData = views || rating || emotions.length || comments.length || characterVote;
      if (!hasUserData) return null;
      return {
        id: episode.id,
        showId: episode.season.show.media.id,
        season: episode.season.number,
        number: episode.number,
        absoluteNumber: episode.absoluteNumber,
        title: episode.title,
        airDate: iso(episode.airDate),
        runtimeMinutes: episode.runtimeMinutes,
        ids: toPortableIds(episode.externalIds),
        ...(views ? { views } : {}),
        ...(rating ? { rating } : {}),
        ...(emotions.length ? { emotions } : {}),
        ...(characterVote ? { characterVote } : {}),
        ...(comments.length ? { comments } : {}),
      };
    })
    .filter(Boolean);

  for (const legacy of legacyEpisodeViews.values()) {
    episodes.push({
      id: legacy.id,
      showId: legacy.showId,
      season: legacy.season,
      number: legacy.number,
      ids: {},
      views: viewsFor(null, legacy.dates),
    });
  }

  const lists = snapshot.customLists.map((list: any) => ({
    id: list.id,
    title: list.title,
    description: list.description,
    coverUrl: list.coverUrl ?? null,
    visibility: list.visibility,
    createdAt: iso(list.createdAt),
    updatedAt: iso(list.updatedAt),
    items: [...list.items]
      .sort((a: any, b: any) => a.order - b.order)
      .map((item: any) => ({
        mediaId: item.mediaId,
        addedAt: iso(item.createdAt),
      })),
  }));

  const profile = snapshot.profile;
  const notificationPrefs = snapshot.notificationPreference;
  const output = {
    format: 'tvwatchtime-library',
    version: EXPORT_FORMAT_VERSION,
    exportedAt: snapshot.exportedAt,
    user: {
      username: snapshot.account.username,
      joinedAt: iso(snapshot.account.createdAt),
      ...(snapshot.restoreToken ? { restoreToken: snapshot.restoreToken } : {}),
      ...(profile
        ? {
            profile: {
              displayName: profile.displayName ?? null,
              bio: profile.bio ?? null,
              location: profile.location ?? null,
              isPrivate: profile.isPrivate,
              hideAnimeInExplore: profile.hideAnimeInExplore,
              exploreDefaultFilters: profile.exploreDefaultFilters ?? null,
              exploreSections: profile.exploreSections ?? null,
              theme: profile.themePreference,
              language: profile.languagePreference,
            },
          }
        : {}),
      ...(notificationPrefs
        ? {
            notificationPreferences: {
              categories: notificationPrefs.preferences ?? {},
              quietHoursEnabled: notificationPrefs.quietHoursEnabled,
              quietHoursStart: notificationPrefs.quietHoursStart ?? null,
              quietHoursEnd: notificationPrefs.quietHoursEnd ?? null,
              timezone: notificationPrefs.timezone ?? null,
              timing: notificationPrefs.timing,
            },
          }
        : {}),
    },
    shows,
    movies,
    episodes,
    lists,
    providerAlerts: (snapshot.providerAlerts ?? []).map((alert: any) => ({
      mediaId: alert.mediaId,
      offerType: alert.offerType,
      country: alert.country,
      providerIds: alert.providerIds ?? [],
      active: alert.active,
      createdAt: iso(alert.createdAt),
    })),
    social: {
      following: (snapshot.follows ?? []).map((row: any) => ({
        username: row.username,
        since: iso(row.createdAt),
      })),
      blocked: (snapshot.blocks ?? []).map((row: any) => ({
        username: row.username,
        since: iso(row.createdAt),
      })),
      listSubscriptions: (snapshot.listSubscriptions ?? []).map((row: any) => ({
        listId: row.listId,
        title: row.title,
        owner: row.owner,
        notifyOnAdd: row.notifyOnAdd,
        since: iso(row.createdAt),
      })),
      likedLists: (snapshot.listLikes ?? []).map((row: any) => ({
        listId: row.listId,
        title: row.title,
        owner: row.owner,
        since: iso(row.createdAt),
      })),
    },
  };
  zip.addFile('tvwatchtime-export.json', json(output));
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
      const payload = buildUserExportArchive({
        ...snapshot,
        restoreToken: this.restoreTokenFor(userId),
      });
      const token = crypto.randomBytes(32).toString('hex');
      const date = new Date().toISOString().slice(0, 10);
      const fileName = `${EXPORT_FILE_PREFIX}${date}.zip`;
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
        fileName: { startsWith: EXPORT_FILE_PREFIX },
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

  /** Lets a later re-import reclaim contributions that account deletion moved to a ghost. */
  private restoreTokenFor(userId: string): string | null {
    const secret = this.config.get<string>('jwt.secret');
    if (!secret) return null;
    try {
      return signAccountRestoreToken(secret, userId);
    } catch {
      return null;
    }
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
      profile,
      notificationPreference,
      providerAlerts,
      follows,
      blocks,
      listSubscriptions,
      listLikes,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { username: true, createdAt: true },
      }),
      this.prisma.userShowStatus.findMany({
        where: { userId },
        select: {
          mediaId: true,
          watchedCount: true,
          totalCount: true,
          lastWatchedAt: true,
          dropped: true,
          pausedAt: true,
          rewatchStartedAt: true,
        },
      }),
      this.prisma.userEpisodeStatus.findMany({
        where: { userId },
        select: {
          episodeId: true,
          watched: true,
          watchedAt: true,
          watchCount: true,
          device: true,
        },
      }),
      this.prisma.userMovieStatus.findMany({
        where: { userId },
        select: { mediaId: true, watched: true, watchedAt: true, watchCount: true, device: true },
      }),
      this.prisma.watchHistory.findMany({
        where: { userId },
        select: {
          mediaId: true,
          mediaType: true,
          episodeId: true,
          seasonNumber: true,
          episodeNumber: true,
          watchedAt: true,
        },
        orderBy: { watchedAt: 'asc' },
      }),
      this.prisma.watchlistItem.findMany({
        where: { userId },
        select: { mediaId: true, priority: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.favorite.findMany({
        where: { userId },
        select: { mediaId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.rating.findMany({
        where: { userId },
        select: {
          mediaId: true,
          episodeId: true,
          rating: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.reaction.findMany({
        where: { userId },
        select: {
          mediaId: true,
          episodeId: true,
          reaction: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.characterVote.findMany({
        where: { userId },
        select: {
          episodeId: true,
          mediaId: true,
          createdAt: true,
          cast: {
            select: {
              character: true,
              characterExternalId: true,
              externalIds: { select: { provider: true, value: true } },
              castMember: {
                select: {
                  name: true,
                  tmdbId: true,
                  tvdbId: true,
                  imdbId: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.customList.findMany({
        where: { userId },
        select: {
          id: true,
          title: true,
          description: true,
          coverUrl: true,
          visibility: true,
          createdAt: true,
          updatedAt: true,
          items: {
            select: { mediaId: true, order: true, createdAt: true },
            orderBy: { order: 'asc' },
          },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.comment.findMany({
        where: { userId },
        select: {
          id: true,
          parentId: true,
          threadType: true,
          threadId: true,
          mediaId: true,
          body: true,
          source: true,
          sourceKey: true,
          commsUniCommentId: true,
          commsUniParentId: true,
          isSpoiler: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.userProfile.findUnique({
        where: { userId },
        select: {
          displayName: true,
          bio: true,
          location: true,
          isPrivate: true,
          hideAnimeInExplore: true,
          exploreDefaultFilters: true,
          exploreSections: true,
          themePreference: true,
          languagePreference: true,
        },
      }),
      this.prisma.notificationPreference.findUnique({
        where: { userId },
        select: {
          preferences: true,
          quietHoursEnabled: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          timezone: true,
          timing: true,
        },
      }),
      this.prisma.watchProviderAlert.findMany({
        where: { userId },
        select: {
          mediaId: true,
          offerType: true,
          country: true,
          providerIds: true,
          active: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.follow.findMany({
        where: { followerId: userId, target: { isShadow: false } },
        select: { createdAt: true, target: { select: { username: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.block.findMany({
        where: { blockerId: userId, blocked: { isShadow: false } },
        select: { createdAt: true, blocked: { select: { username: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      // Own lists are recreated with new ids on restore, so only other people's lists count.
      this.prisma.listSubscription.findMany({
        where: { userId, list: { userId: { not: userId } } },
        select: {
          notifyOnAdd: true,
          createdAt: true,
          list: { select: { id: true, title: true, user: { select: { username: true } } } },
        },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.listLike.findMany({
        where: { userId, list: { userId: { not: userId } } },
        select: {
          createdAt: true,
          list: { select: { id: true, title: true, user: { select: { username: true } } } },
        },
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
    characterVotes.forEach((item) => {
      addEpisode(item.episodeId);
      addMedia(item.mediaId);
    });
    customLists.forEach((list) => list.items.forEach((item) => addMedia(item.mediaId)));
    providerAlerts.forEach((alert) => addMedia(alert.mediaId));
    comments.forEach((comment) => {
      addMedia(comment.mediaId);
      if (comment.threadType === 'EPISODE') addEpisode(comment.threadId);
      if (comment.threadType === 'SHOW' || comment.threadType === 'MOVIE')
        addMedia(comment.threadId);
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

    // Supplemental episode rows reference their parent show by TVWatchTime id. The episode query
    // already carries that compact show record, so merge it into the catalog without another query.
    const catalogMedia = [...media];
    const catalogMediaIds = new Set(catalogMedia.map((item) => item.id));
    for (const episode of episodes) {
      const parentShow = episode.season.show.media;
      if (!catalogMediaIds.has(parentShow.id)) {
        catalogMedia.push(parentShow);
        catalogMediaIds.add(parentShow.id);
      }
    }

    return {
      exportedAt: new Date().toISOString(),
      account,
      catalog: { media: catalogMedia, episodes },
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
      profile,
      notificationPreference,
      providerAlerts,
      follows: follows.map((row) => ({ username: row.target.username, createdAt: row.createdAt })),
      blocks: blocks.map((row) => ({ username: row.blocked.username, createdAt: row.createdAt })),
      listSubscriptions: listSubscriptions.map((row) => ({
        listId: row.list.id,
        title: row.list.title,
        owner: row.list.user.username,
        notifyOnAdd: row.notifyOnAdd,
        createdAt: row.createdAt,
      })),
      listLikes: listLikes.map((row) => ({
        listId: row.list.id,
        title: row.list.title,
        owner: row.list.user.username,
        createdAt: row.createdAt,
      })),
    };
  }
}
