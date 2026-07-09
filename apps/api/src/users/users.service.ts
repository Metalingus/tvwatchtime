import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { mapCurrentUser, mapPublicUser } from '../common/utils/mapper.util';
import { DeviceRegisterDto, UpdateProfileDto } from './dto/user.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

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
    if (dto.username) {
      const taken = await this.prisma.user.findFirst({
        where: { username: dto.username, NOT: { id: userId } },
      });
      if (taken) throw new ConflictException('Username already taken');
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: dto.username ? { username: dto.username } : {},
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
      },
      update: {
        displayName: dto.displayName,
        bio: dto.bio,
        avatarUrl: dto.avatarUrl,
        coverUrl: dto.coverUrl,
        isPrivate: dto.isPrivate,
      },
    });
    return this.getMe(userId);
  }

  async deleteMe(userId: string) {
    await this.prisma.user.delete({ where: { id: userId } });
    return { ok: true };
  }

  async registerDevice(userId: string, dto: DeviceRegisterDto) {
    const device = await this.prisma.device.upsert({
      where: { token: dto.token },
      create: {
        userId,
        token: dto.token,
        platform: dto.platform,
        appVersion: dto.appVersion,
        timezone: dto.timezone,
        active: true,
      },
      update: { userId, platform: dto.platform, appVersion: dto.appVersion, timezone: dto.timezone, active: true },
    });
    return { id: device.id };
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
      (await this.prisma.follow.findMany({ where: { followerId: userId }, select: { targetId: true } })).map(f => f.targetId),
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
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: { profile: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const [followersCount, followingCount, isFollowing] = await Promise.all([
      this.prisma.follow.count({ where: { targetId: user.id } }),
      this.prisma.follow.count({ where: { followerId: user.id } }),
      viewerId ? this.prisma.follow.findUnique({ where: { followerId_targetId: { followerId: viewerId, targetId: user.id } } }) : null,
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

  async getFollows(userId: string, type: 'followers' | 'following', viewerId?: string) {
    const follows = type === 'followers'
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
      ? new Set((await this.prisma.follow.findMany({ where: { followerId: viewerId }, select: { targetId: true } })).map(f => f.targetId))
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
    const user = await this.prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) throw new NotFoundException('User not found');
    return this.getFollows(user.id, type, viewerId);
  }
}
