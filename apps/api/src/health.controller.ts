import { Controller, Get, Post, Body, HttpException, HttpStatus } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from './common/decorators/public.decorator';
import { FeatureFlagService } from './common/feature-flag.service';
import { CapabilityService } from './common/capability.service';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './common/redis/redis.service';

@SkipThrottle()
@Controller()
export class HealthController {
  constructor(
    private readonly flags: FeatureFlagService,
    private readonly capabilities: CapabilityService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get('health')
  check() {
    return { status: 'ok', ts: new Date().toISOString() };
  }

  @Public()
  @Get('feature-flags')
  async getPublicFlags() {
    const keys = ['comments_enabled', 'public_profiles', 'imports_enabled', 'push_notifications', 'recommendations'];
    const result: Record<string, boolean> = {};
    for (const k of keys) result[k] = await this.flags.isEnabled(k);
    // Merge runtime capabilities (what's actually configured)
    const caps = this.capabilities.all;
    result.comment_images = caps.commentImages;
    result.social_google = caps.socialGoogle;
    result.social_facebook = caps.socialFacebook;
    result.social_apple = caps.socialApple;
    result.push_enabled = caps.push;
    result.tmdb_enabled = caps.tmdb;
    result.tvmaze_enabled = caps.tvmaze;
    return result;
  }

  /** Public push relay — allows self-hosted backends to send pushes through this Expo project.
   *  Rate limited per device token to prevent abuse. */
  @Public()
  @Post('push/relay')
  async pushRelay(@Body() body: { token: string; title: string; body?: string; data?: Record<string, unknown> }) {
    const enabled = this.config.get<boolean>('pushRelay.enabled') ?? true;
    if (!enabled) throw new HttpException('Push relay disabled', HttpStatus.SERVICE_UNAVAILABLE);
    if (!body?.token || !body?.title) throw new HttpException('token and title required', HttpStatus.BAD_REQUEST);

    // Rate limit per token
    const rateLimit = this.config.get<number>('pushRelay.rateLimit') ?? 10;
    const windowMin = this.config.get<number>('pushRelay.rateWindowMinutes') ?? 10;
    const windowKey = Math.floor(Date.now() / (windowMin * 60 * 1000));
    const redisKey = `relay:push:${body.token}:${windowKey}`;
    const current = await this.redis.client.incr(redisKey);
    if (current === 1) await this.redis.client.expire(redisKey, windowMin * 60);
    if (current > rateLimit) {
      throw new HttpException(`Rate limit exceeded (${rateLimit}/${windowMin}min)`, HttpStatus.TOO_MANY_REQUESTS);
    }

    // Send via Expo Push API
    const expoToken = this.config.get<string>('push.expoAccessToken');
    if (!expoToken) throw new HttpException('Push not configured on this server', HttpStatus.SERVICE_UNAVAILABLE);

    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${expoToken}`,
      },
      body: JSON.stringify([{
        to: body.token,
        title: body.title,
        body: body.body,
        data: body.data,
        sound: 'default',
      }]),
    });

    if (!res.ok) throw new HttpException('Push delivery failed', HttpStatus.BAD_GATEWAY);
    return { ok: true, remaining: rateLimit - current };
  }
}
