import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { OAuth2Client } from 'google-auth-library';
import * as appleSignin from 'apple-signin-auth';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { EmailService } from '../common/email.service';
import type { JwtPayload } from './jwt.strategy';
import { EmailLoginDto, EmailRegisterDto, SocialLoginDto } from './dto/auth.dto';
import type { AuthSessionDto } from '@tvwatch/shared';

function uid(len = 6): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

interface SocialProfile {
  providerUid: string;
  email?: string;
  name?: string;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly googleClient: OAuth2Client;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
  ) {
    this.googleClient = new OAuth2Client(this.config.get<string>('auth.google.clientId'));
  }

  async register(dto: EmailRegisterDto): Promise<AuthSessionDto> {
    const exists = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { username: dto.username }] },
    });
    if (exists) throw new ConflictException('Email or username already in use');

    const passwordHash = await argon2.hash(dto.password);

    // Bootstrap: first user matching BOOTSTRAP_SUPER_ADMIN_EMAIL when no SUPER_ADMIN exists
    const bootstrapEmail = this.config.get<string>('auth.bootstrapSuperAdminEmail');
    let role: 'USER' | 'SUPER_ADMIN' = 'USER';
    let mustChangePassword = false;
    if (bootstrapEmail && dto.email.toLowerCase() === bootstrapEmail.toLowerCase()) {
      const adminCount = await this.prisma.user.count({ where: { role: 'SUPER_ADMIN' } });
      if (adminCount === 0) {
        role = 'SUPER_ADMIN';
        mustChangePassword = true;
        this.logger.log('Bootstrapping first SUPER_ADMIN');
      }
    }

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        username: dto.username,
        passwordHash,
        role,
        mustChangePassword,
        emailVerified: false,
        authProviders: { create: { provider: 'EMAIL', providerUid: dto.email } },
        profile: { create: { displayName: dto.username } },
      },
    });
    return this.issueSession(user.id, user.username, user.email, user.role, user.mustChangePassword);
  }

  async login(dto: EmailLoginDto): Promise<AuthSessionDto> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      include: { authProviders: true },
    });
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');
    const ok = await argon2.verify(user.passwordHash, dto.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    return this.issueSession(user.id, user.username, user.email, user.role, user.mustChangePassword);
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.passwordHash) throw new UnauthorizedException('User has no password set');
    const ok = await argon2.verify(user.passwordHash, oldPassword);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');
    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: false },
    });
  }

  async forgotPassword(emailAddr: string): Promise<{ sent: boolean }> {
    const user = await this.prisma.user.findUnique({
      where: { email: emailAddr.toLowerCase() },
      select: { id: true },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.passwordReset.create({
      data: { email: emailAddr.toLowerCase(), userId: user?.id ?? null, token, expiresAt },
    });

    if (user) {
      const siteUrl = this.config.get<string>('site.url') || 'https://tvwatchtime.org';
      const link = `${siteUrl}/reset-password?token=${token}`;
      if (this.email.enabled) {
        const html = `
          <h2>Reset Your Password</h2>
          <p>You requested a password reset for your TVWatchTime account.</p>
          <p style="margin: 24px 0;">
            <a href="${link}" style="background:#FFD60A;color:#0F1115;padding:12px 32px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:16px;">Reset Password</a>
          </p>
          <p style="color:#666;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
        `;
        await this.email.send(emailAddr, 'Reset Your Password — TVWatchTime', html);
      } else {
        this.logger.log(`SMTP not configured — reset link for ${emailAddr}: ${link}`);
      }
    }

    return { sent: true };
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const reset = await this.prisma.passwordReset.findUnique({ where: { token } });
    if (!reset) throw new BadRequestException('Invalid or expired reset link');
    if (reset.usedAt) throw new BadRequestException('This reset link has already been used');
    if (reset.expiresAt < new Date()) throw new BadRequestException('This reset link has expired');
    if (!reset.userId) throw new BadRequestException('Invalid reset link');

    const passwordHash = await argon2.hash(newPassword);
    await this.prisma.user.update({
      where: { id: reset.userId },
      data: { passwordHash, mustChangePassword: false },
    });
    await this.prisma.passwordReset.update({
      where: { id: reset.id },
      data: { usedAt: new Date() },
    });
  }

  async socialLogin(dto: { provider: any; token?: string; authorizationCode?: string; nonce?: string; username?: string; redirectUri?: string }): Promise<AuthSessionDto> {
    const profile = dto.token
      ? dto.provider === 'GOOGLE'
        ? await this.verifyGoogle(dto.token)
        : dto.provider === 'APPLE'
          ? await this.verifyApple(dto.token)
          : dto.provider === 'FACEBOOK'
            ? await this.verifyFacebook(dto.token)
            : (() => { throw new UnauthorizedException('Unsupported provider'); })()
      : dto.authorizationCode && dto.redirectUri
        ? await this.exchangeCode(dto.provider, dto.authorizationCode, dto.redirectUri)
        : (() => { throw new UnauthorizedException('Token or authorization code required'); })();

    const existing = await this.prisma.userAuthProvider.findUnique({
      where: { provider_providerUid: { provider: dto.provider, providerUid: profile.providerUid } },
      include: { user: true },
    });

    let user = existing?.user;
    if (!user) {
      const email = profile.email || `${dto.provider}_${profile.providerUid}@social.local`;
      const baseName = dto.username || profile.name || `user_${uid(6)}`;
      const username = await this.ensureUniqueUsername(baseName);
      user = await this.prisma.user.create({
        data: {
          email,
          username,
          emailVerified: true,
          authProviders: {
            create: { provider: dto.provider, providerUid: profile.providerUid },
          },
          profile: { create: { displayName: username } },
        },
      });
    }
    return this.issueSession(user.id, user.username, user.email, user.role, user.mustChangePassword);
  }

  async refresh(refreshToken: string): Promise<AuthSessionDto> {
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(refreshToken, {
        secret: this.config.get<string>('jwt.secret')!,
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (payload.kind !== 'refresh') throw new UnauthorizedException('Invalid refresh token');
    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) throw new NotFoundException('User not found');
    return this.issueSession(user.id, user.username, user.email, user.role, user.mustChangePassword);
  }

  async issueSession(
    userId: string,
    username: string,
    email: string,
    role: string,
    mustChangePassword: boolean,
  ): Promise<AuthSessionDto> {
    const access = this.signToken({ sub: userId, username, email, role }, 'access');
    const refresh = this.signToken({ sub: userId, username, email, role }, 'refresh');
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, authProviders: true },
    });
    if (!user) throw new NotFoundException('User not found');
    const followersCount = await this.prisma.follow.count({ where: { targetId: userId } });
    const followingCount = await this.prisma.follow.count({ where: { followerId: userId } });
    const commentsCount = await this.prisma.comment.count({ where: { userId } });
    return {
      accessToken: access,
      refreshToken: refresh,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.profile?.displayName ?? null,
        avatarUrl: user.profile?.avatarUrl ?? null,
        coverUrl: user.profile?.coverUrl ?? null,
        bio: user.profile?.bio ?? null,
        followingCount,
        followersCount,
        commentsCount,
        createdAt: new Date(user.createdAt).toISOString(),
        email: user.email,
        authProviders: user.authProviders.map((a) => a.provider),
        isPrivate: user.profile?.isPrivate ?? false,
        role: user.role,
        mustChangePassword: user.mustChangePassword,
      } as any,
    };
  }

  private signToken(payload: JwtPayload, kind: 'access' | 'refresh'): string {
    return this.jwt.sign(
      { ...payload, kind },
      {
        secret: this.config.get<string>('jwt.secret')!,
        expiresIn: kind === 'access' ? this.config.get<string>('jwt.accessTtl') : this.config.get<string>('jwt.refreshTtl'),
      },
    );
  }

  private async ensureUniqueUsername(base: string): Promise<string> {
    let candidate = base.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 18);
    if (!candidate) candidate = 'user';
    for (let i = 0; i < 10; i++) {
      const name = i === 0 ? candidate : `${candidate}_${uid(4)}`;
      const taken = await this.prisma.user.findUnique({ where: { username: name } });
      if (!taken) return name;
    }
    return `${candidate}_${uid(8)}`;
  }

  // ---- OAuth verification ----
  private async verifyGoogle(idToken: string): Promise<SocialProfile> {
    const ticket = await this.googleClient.verifyIdToken({
      idToken,
      audience: this.config.get<string>('auth.google.clientId'),
    });
    const p = ticket.getPayload();
    if (!p?.sub) throw new UnauthorizedException('Invalid Google token');
    return { providerUid: p.sub, email: p.email, name: p.name };
  }

  /** Exchange an authorization code for tokens, then verify. */
  private async exchangeCode(provider: string, code: string, redirectUri: string): Promise<SocialProfile> {
    if (provider === 'GOOGLE') {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.config.get<string>('auth.google.clientId')!,
          client_secret: this.config.get<string>('auth.google.clientSecret')!,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new UnauthorizedException('Google code exchange failed');
      const tokens: any = await tokenRes.json();
      return this.verifyGoogle(tokens.id_token);
    }

    if (provider === 'FACEBOOK') {
      const appId = this.config.get<string>('auth.facebook.appId')!;
      const appSecret = this.config.get<string>('auth.facebook.appSecret')!;
      const tokenUrl = `https://graph.facebook.com/v18.0/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
      const tokenRes = await fetch(tokenUrl);
      if (!tokenRes.ok) throw new UnauthorizedException('Facebook code exchange failed');
      const tokenData: any = await tokenRes.json();
      return this.verifyFacebook(tokenData.access_token);
    }

    throw new UnauthorizedException(`Code exchange not supported for ${provider}`);
  }

  private async verifyApple(idToken: string): Promise<SocialProfile> {
    try {
      const { sub, email } = await appleSignin.verifyIdToken(idToken, {
        audience: this.config.get<string>('auth.apple.clientId'),
    });
      if (!sub) throw new UnauthorizedException('Invalid Apple token');
      return { providerUid: sub, email };
    } catch (e) {
      this.logger.warn(`Apple verify failed: ${(e as Error).message}`);
      throw new UnauthorizedException('Invalid Apple token');
    }
  }

  private async verifyFacebook(accessToken: string): Promise<SocialProfile> {
    const url = new URL('https://graph.facebook.com/me');
    url.searchParams.set('fields', 'id,name,email');
    url.searchParams.set('access_token', accessToken);
    const res = await fetch(url.toString());
    if (!res.ok) throw new UnauthorizedException('Invalid Facebook token');
    const data = (await res.json()) as { id: string; email?: string; name?: string };
    return { providerUid: data.id, email: data.email, name: data.name };
  }
}
