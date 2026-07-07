import { CanActivate, ExecutionContext, Injectable, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../common/prisma/prisma.service';
import { ROLES_KEY } from './roles.decorator';

const ROLE_RANK: Record<string, number> = {
  USER: 0, VIEWER: 1, SUPPORT: 2, CONTENT_MANAGER: 3, MODERATOR: 4, ADMIN: 5, SUPER_ADMIN: 6,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!requiredRoles || requiredRoles.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as { id: string } | undefined;
    if (!user) throw new UnauthorizedException('Authentication required');

    const dbUser = await this.prisma.user.findUnique({ where: { id: user.id }, select: { role: true, isSuspended: true } });
    if (!dbUser) throw new ForbiddenException('User not found');
    if (dbUser.isSuspended) throw new ForbiddenException('Account suspended');

    const userRank = ROLE_RANK[dbUser.role] ?? 0;
    const minRequired = Math.min(...requiredRoles.map((r) => ROLE_RANK[r] ?? 0));
    if (userRank < minRequired) throw new ForbiddenException(`Requires ${requiredRoles.join(' or ')} role`);
    return true;
  }
}
