import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { AppleAuthService } from '../auth/apple-auth.service';
import {
  mapCurrentUser,
  mapPublicUser,
  dtoThemeToDb,
  dtoLangToDb,
} from '../common/utils/mapper.util';
import { DeviceRegisterDto, UpdateProfileDto } from './dto/user.dto';
import {
  AccountDeletionInProgressError,
  anonymizeAndDeleteUser,
  RESERVED_USERNAMES,
} from './lib/deleted-user';
import { ExportService } from './export.service';
import { EmailService } from '../common/email.service';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly apple: AppleAuthService,
    private readonly exports: ExportService,
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, authProviders: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const [followersCount, followingCount, commentsCount] = await Promise.all([
      this.prisma.follow.count({ where: { targetId: userId } }),
      this.prisma.follow.count({ where: { followerId: userId } }),
      this.prisma.comment.count({ where: { userId } }),
    ]);
    return mapCurrentUser({
      ...user,
      _followersCount: followersCount,
      _followingCount: followingCount,
      _commentsCount: commentsCount,
    });
  }

  async getPublicUser(username: string, viewerId?: string) {
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { profile: true, authProviders: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const [followersCount, followingCount, commentsCount] = await Promise.all([
      this.prisma.follow.count({ where: { targetId: user.id } }),
      this.prisma.follow.count({ where: { followerId: user.id } }),
      this.prisma.comment.count({ where: { userId: user.id } }),
    ]);
    return mapPublicUser({
      ...user,
      _followersCount: followersCount,
      _followingCount: followingCount,
      _commentsCount: commentsCount,
    });
  }

  async updateMe(userId: string, dto: UpdateProfileDto) {
    const username = dto.username?.trim();
    if (username) {
      if (RESERVED_USERNAMES.has(username.toLowerCase())) {
        throw new ConflictException('This username is reserved');
      }
      const taken = await this.prisma.user.findFirst({
        where: { username, NOT: { id: userId } },
      });
      if (taken) throw new ConflictException('Username already taken');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: username ? { username } : {},
    });
    await this.prisma.userProfile.upsert({
      where: { userId },
      create: {
        userId,
        displayName: dto.displayName ?? null,
        bio: dto.bio ?? null,
        avatarUrl: dto.avatarUrl ?? null,
        coverUrl: dto.coverUrl ?? null,
        isPrivate: dto.isPrivate ?? false,
        hideAnimeInExplore: dto.hideAnimeInExplore ?? false,
        exploreDefaultFilters:
          dto.exploreDefaultFilters === null
            ? Prisma.DbNull
            : dto.exploreDefaultFilters
              ? this.normalizeExploreDefaults(dto.exploreDefaultFilters)
              : undefined,
        ...(dto.themePreference
          ? { themePreference: dtoThemeToDb(dto.themePreference) as any }
          : {}),
        ...(dto.languagePreference
          ? { languagePreference: dtoLangToDb(dto.languagePreference) as any }
          : {}),
      },
      update: {
        displayName: dto.displayName,
        bio: dto.bio,
        avatarUrl: dto.avatarUrl,
        coverUrl: dto.coverUrl,
        isPrivate: dto.isPrivate,
        hideAnimeInExplore: dto.hideAnimeInExplore,
        ...(dto.exploreDefaultFilters !== undefined
          ? {
              exploreDefaultFilters:
                dto.exploreDefaultFilters === null
                  ? Prisma.DbNull
                  : this.normalizeExploreDefaults(dto.exploreDefaultFilters),
            }
          : {}),
        ...(dto.themePreference
          ? { themePreference: dtoThemeToDb(dto.themePreference) as any }
          : {}),
        ...(dto.languagePreference
          ? { languagePreference: dtoLangToDb(dto.languagePreference) as any }
          : {}),
      },
    });
    if (dto.isPrivate !== undefined) {
      this.events?.emit('leaderboard.user-changed', { userId });
    }
    return this.getMe(userId);
  }

  private normalizeExploreDefaults(value: NonNullable<UpdateProfileDto['exploreDefaultFilters']>) {
    const genre = value.genre?.trim() || null;
    const country = value.country?.trim().toUpperCase() || null;
    const excludeGenres = [...new Set(value.excludeGenres.map((v) => v.trim()).filter(Boolean))]
      .filter((v) => v !== genre)
      .sort();
    const tags = [...new Set((value.tags ?? []).map((v) => v.trim()).filter(Boolean))].sort();
    return {
      genre,
      excludeGenres,
      tags,
      order: value.order,
      mediaType: value.mediaType,
      country,
      hideAnime: value.hideAnime,
    };
  }

  async deleteMe(userId: string) {
    await this.deleteUserAccount(userId);
    return { ok: true };
  }

  /** Shared by self-service/email deletion and the audited admin deletion path. */
  async deleteUserAccount(userId: string) {
    // Keep the destination only in request memory before the user row and deletion-request
    // identity are removed/anonymized. Never attempt to look it up after the transaction.
    const account = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true },
    });
    await this.revokeAppleProviders(userId);
    // Evict the JWT existence cache BEFORE the row delete so in-flight requests
    // re-check the DB instead of racing through on the stale positive entry.
    await this.redis.del(`auth:user:${userId}`);
    // Public/community contributions move to a unique non-login ghost; private account,
    // library, history, device, credential, and notification data cascades away.
    let preserved;
    try {
      preserved = await anonymizeAndDeleteUser(this.prisma, userId);
    } catch (e) {
      if (e instanceof AccountDeletionInProgressError) {
        throw new ConflictException(e.message);
      }
      throw e;
    }
    this.events?.emit('leaderboard.user-changed', { userId });
    let exportsDeleted = 0;
    try {
      exportsDeleted = await this.exports.deleteForUser(userId);
    } catch (e) {
      // The account deletion has already committed and must not be reported as failed.
      // Export rows remain available to the normal expiry cleanup for a later retry.
      this.logger.warn(
        `Deferred export cleanup for deleted user ${userId}: ${(e as Error).message}`,
      );
    }
    if (preserved && account?.email && this.email) {
      const username = this.escapeEmailHtml(account.username);
      const html = `
        <h2>Your TV Watch Time account has been deleted</h2>
        <p>Hello <strong>${username}</strong>,</p>
        <p>Your TVWatchTime account and private account data have been permanently deleted.</p>
        <p>No further action is required.</p>
      `;
      await this.email
        .send(account.email, 'Your TV Watch Time Account Has Been Deleted', html)
        .catch((e) =>
          this.logger.warn(
            `Could not send deletion confirmation for user ${userId}: ${(e as Error).message}`,
          ),
        );
    }
    return preserved ? { ...preserved, exportsDeleted } : null;
  }

  private escapeEmailHtml(value: string): string {
    return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  private async revokeAppleProviders(userId: string) {
    const providers = await this.prisma.userAuthProvider.findMany({
      where: { userId, provider: 'APPLE', refreshToken: { not: null } },
      select: { id: true, refreshToken: true },
    });
    await Promise.all(
      providers.map((provider) =>
        this.apple.revokeEncryptedRefreshToken(provider.refreshToken, provider.id),
      ),
    );
  }

  async registerDevice(userId: string, dto: DeviceRegisterDto) {
    try {
      const device = await this.prisma.device.upsert({
        where: { token: dto.token },
        create: {
          userId,
          token: dto.token,
          platform: dto.platform,
          appVersion: dto.appVersion,
          timezone: dto.timezone,
          pushP256dh: dto.pushP256dh,
          pushAuth: dto.pushAuth,
          active: true,
        },
        update: {
          userId,
          platform: dto.platform,
          appVersion: dto.appVersion,
          timezone: dto.timezone,
          pushP256dh: dto.pushP256dh,
          pushAuth: dto.pushAuth,
          active: true,
        },
      });
      return { id: device.id };
    } catch (e) {
      // The JWT guard caches user existence briefly (60s), so a request can arrive
      // right after the account was deleted — the FK to users fails. That's an
      // auth-state problem, not a server error.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new NotFoundException('User not found');
      }
      throw e;
    }
  }

  async removeDevice(userId: string, deviceId: string) {
    await this.prisma.device.deleteMany({ where: { id: deviceId, userId } });
    return { ok: true };
  }

  async searchUsers(query: string, userId: string) {
    const users = await this.prisma.user.findMany({
      where: {
        AND: [
          { id: { not: userId } },
          {
            OR: [
              { username: { contains: query, mode: 'insensitive' } },
              { profile: { displayName: { contains: query, mode: 'insensitive' } } },
            ],
          },
          { isSuspended: false },
        ],
      },
      include: { profile: true },
      take: 20,
    });

    const followingIds = new Set(
      (
        await this.prisma.follow.findMany({
          where: { followerId: userId },
          select: { targetId: true },
        })
      ).map((f) => f.targetId),
    );

    return users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.profile?.displayName ?? null,
      avatarUrl: u.profile?.avatarUrl ?? null,
      isFollowing: followingIds.has(u.id),
    }));
  }

  async getPublicProfile(username: string, viewerId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: username.trim() },
      include: { profile: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const [followersCount, followingCount, isFollowing] = await Promise.all([
      this.prisma.follow.count({ where: { targetId: user.id } }),
      this.prisma.follow.count({ where: { followerId: user.id } }),
      viewerId
        ? this.prisma.follow.findUnique({
            where: { followerId_targetId: { followerId: viewerId, targetId: user.id } },
          })
        : null,
    ]);

    return {
      id: user.id,
      username: user.username,
      displayName: user.profile?.displayName ?? null,
      avatarUrl: user.profile?.avatarUrl ?? null,
      coverUrl: user.profile?.coverUrl ?? null,
      bio: user.profile?.bio ?? null,
      isPrivate: user.profile?.isPrivate ?? false,
      followersCount,
      followingCount,
      isFollowing: !!isFollowing,
      isMe: viewerId === user.id,
    };
  }

  /**
   * A user's PUBLIC lists for the profile page. Private profiles expose them only to
   * the owner and their followers (same rule as profile visibility).
   */
  async getUserPublicLists(username: string, viewerId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: username.trim() },
      include: { profile: { select: { isPrivate: true } } },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.profile?.isPrivate && viewerId !== user.id) {
      const following = viewerId
        ? await this.prisma.follow.findUnique({
            where: { followerId_targetId: { followerId: viewerId, targetId: user.id } },
          })
        : null;
      if (!following) throw new ForbiddenException('This profile is private');
    }
    if (viewerId) {
      const blocked = await this.prisma.block.findFirst({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: user.id },
            { blockerId: user.id, blockedId: viewerId },
          ],
        },
        select: { id: true },
      });
      if (blocked) throw new ForbiddenException('Profile unavailable');
    }
    const lists = await this.prisma.customList.findMany({
      where: { userId: user.id, visibility: 'PUBLIC' },
      orderBy: { updatedAt: 'desc' },
      include: { _count: { select: { items: true, likes: true, subscriptions: true } } },
    });
    if (!lists.length) return [];
    // Show/movie item counts per list + first-item cover fallback — two batched queries.
    const [counts, covers] = await Promise.all([
      this.prisma.$queryRaw<{ listId: string; type: string; c: number }[]>`
        SELECT cli.list_id AS "listId", m.type, COUNT(*)::int AS c
        FROM custom_list_items cli
        JOIN media_items m ON m.id = cli.media_id
        WHERE cli.list_id IN (${Prisma.join(lists.map((l) => l.id))})
        GROUP BY cli.list_id, m.type`,
      this.prisma.$queryRaw<{ listId: string; backdrop: string | null; poster: string | null }[]>`
        SELECT DISTINCT ON (cli.list_id)
               cli.list_id AS "listId",
               m.backdrop_url AS backdrop,
               m.poster_url AS poster
        FROM custom_list_items cli
        JOIN media_items m ON m.id = cli.media_id
        WHERE cli.list_id IN (${Prisma.join(lists.map((l) => l.id))})
        ORDER BY cli.list_id, cli.created_at`,
    ]);
    const countByList = new Map<string, { shows: number; movies: number }>();
    for (const r of counts) {
      const e = countByList.get(r.listId) ?? { shows: 0, movies: 0 };
      if (r.type === 'SHOW') e.shows = r.c;
      else e.movies = r.c;
      countByList.set(r.listId, e);
    }
    const coverByList = new Map(covers.map((c) => [c.listId, c.backdrop ?? c.poster]));
    return lists.map((l) => ({
      id: l.id,
      title: l.title,
      description: l.description,
      coverUrl: l.coverUrl ?? coverByList.get(l.id) ?? null,
      showCount: countByList.get(l.id)?.shows ?? 0,
      movieCount: countByList.get(l.id)?.movies ?? 0,
      likeCount: l._count.likes,
      subscriberCount: l._count.subscriptions,
    }));
  }

  async getFollows(userId: string, type: 'followers' | 'following', viewerId?: string) {
    const follows =
      type === 'followers'
        ? await this.prisma.follow.findMany({
            where: { targetId: userId },
            include: { follower: { include: { profile: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
          })
        : await this.prisma.follow.findMany({
            where: { followerId: userId },
            include: { target: { include: { profile: true } } },
            orderBy: { createdAt: 'desc' },
            take: 100,
          });

    const viewerFollowing = viewerId
      ? new Set(
          (
            await this.prisma.follow.findMany({
              where: { followerId: viewerId },
              select: { targetId: true },
            })
          ).map((f) => f.targetId),
        )
      : new Set<string>();

    return follows.map((f: any) => {
      const u = type === 'followers' ? f.follower : f.target;
      return {
        id: u.id,
        username: u.username,
        displayName: u.profile?.displayName ?? null,
        avatarUrl: u.profile?.avatarUrl ?? null,
        isFollowing: viewerFollowing.has(u.id),
      };
    });
  }

  async getFollowsByUsername(username: string, type: 'followers' | 'following', viewerId?: string) {
    const user = await this.prisma.user.findFirst({
      where: { username: username.trim() },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return this.getFollows(user.id, type, viewerId);
  }
}
