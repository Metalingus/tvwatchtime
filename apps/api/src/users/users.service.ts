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
}
