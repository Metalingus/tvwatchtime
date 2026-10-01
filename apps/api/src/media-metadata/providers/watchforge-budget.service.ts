import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisService } from '../../common/redis/redis.service';

/**
 * WatchForge daily quota, split into priority lanes.
 *
 * - interactive: imports, integrations, CommsUni and other user-facing flows.
 * - repair: identity repair jobs, structure authority, movie identity enrichment.
 * - backlog: the one-time catalog cleanup.
 *
 * Each lane has a reserved floor (share × daily limit). A lane may never spend capacity still
 * reserved for a higher-priority lane. Interactive and repair may borrow beyond their floor.
 * Backlog may borrow only after `backlogReleaseHourUtc`, when unused reservations would otherwise
 * be wasted at the UTC-day reset; interactive then keeps only LATE_INTERACTIVE_RESERVE_SHARE.
 *
 * Spend is counted per UTC day in Redis and mirrored to `watchforge_usage_days`, so a Redis flush
 * cannot reset the budget. When WatchForge's X-RateLimit headers describe the daily window, they
 * override our count if they show more usage (e.g. the provider window is rolling, not UTC).
 */
export const WATCHFORGE_LANES = ['interactive', 'repair', 'backlog'] as const;
export type WatchForgeLane = (typeof WATCHFORGE_LANES)[number];
export type LaneNumbers = Record<WatchForgeLane, number>;

export interface WatchForgeBudgetConfig {
  requestsPerDayCap: number | null;
  fallbackRequestsPerDay: number;
  lanes: LaneNumbers;
  backlogReleaseHourUtc: number;
}

export interface AdmissionInput {
  lane: WatchForgeLane;
  limit: number;
  used: LaneNumbers;
  shares: LaneNumbers;
  /** Daily usage reported by WatchForge's own headers, when known. */
  providerUsed?: number | null;
  backlogReleased: boolean;
}

/** After the backlog release hour, interactive keeps this share of the day protected. */
export const LATE_INTERACTIVE_RESERVE_SHARE = 0.1;

/** Pure admission rule; see the class comment for the policy. */
export function admitWatchForgeLane(input: AdmissionInput): boolean {
  const floor = (lane: WatchForgeLane) => Math.floor(input.limit * (input.shares[lane] ?? 0));
  const unmet = (lane: WatchForgeLane) => Math.max(0, floor(lane) - (input.used[lane] ?? 0));
  const total = WATCHFORGE_LANES.reduce((sum, lane) => sum + (input.used[lane] ?? 0), 0);
  const spent = Math.max(total, input.providerUsed ?? 0);
  if (spent >= input.limit) return false;
  const higher = WATCHFORGE_LANES.slice(0, WATCHFORGE_LANES.indexOf(input.lane));
  // Late in the UTC day, unused reservations would be lost at reset: release them to the
  // backlog, except a small interactive reserve for late imports.
  const reservedAbove =
    input.lane === 'backlog' && input.backlogReleased
      ? Math.min(unmet('interactive'), Math.ceil(input.limit * LATE_INTERACTIVE_RESERVE_SHARE))
      : higher.reduce((sum, lane) => sum + unmet(lane), 0);
  if (spent + reservedAbove >= input.limit) return false;
  if ((input.used[input.lane] ?? 0) < floor(input.lane)) return true;
  return input.lane !== 'backlog' || input.backlogReleased;
}

interface ProviderWindow {
  limit: number;
  remaining: number;
  resetAt: number;
}

const DAY_MS = 86_400_000;
const SPEND_TTL_SEC = 3 * 86_400;
const ACCOUNT_LIMIT_TTL_SEC = 6 * 3600;

export const watchForgeCredentialId = (apiKey: string) =>
  createHash('sha256').update(apiKey).digest('hex').slice(0, 16);

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const nextUtcMidnight = (now: number) => Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
const emptyUsage = (): LaneNumbers => ({ interactive: 0, repair: 0, backlog: 0 });

@Injectable()
export class WatchForgeBudget {
  private readonly logger = new Logger(WatchForgeBudget.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  private spendKey(credentialId: string, day: string) {
    return `WF:${credentialId}:spend:${day}`;
  }
  private windowKey(credentialId: string) {
    return `WF:${credentialId}:window`;
  }
  private accountKey(credentialId: string) {
    return `WF:${credentialId}:account-limit`;
  }

  /** Remember the account's per-day limit reported by WatchForge /me. */
  async setAccountLimit(credentialId: string, perDay: number, perMinute?: number | null) {
    if (!Number.isSafeInteger(perDay) || perDay <= 0) return;
    await this.redis.set(
      this.accountKey(credentialId),
      { perDay, perMinute: perMinute ?? null },
      ACCOUNT_LIMIT_TTL_SEC,
    );
  }

  async hasFreshAccountLimit(credentialId: string): Promise<boolean> {
    return (await this.redis.get(this.accountKey(credentialId))) !== null;
  }

  async limit(
    credentialId: string,
    cfg: WatchForgeBudgetConfig,
  ): Promise<{ limit: number; source: 'provider' | 'configured' | 'fallback' }> {
    const account = await this.redis.get<{ perDay: number }>(this.accountKey(credentialId));
    if (account?.perDay) {
      // Keep a small margin for requests we cannot see (other tools using the same key).
      const provider = account.perDay - Math.max(10, Math.ceil(account.perDay * 0.02));
      return {
        limit: Math.max(1, cfg.requestsPerDayCap ? Math.min(provider, cfg.requestsPerDayCap) : provider),
        source: 'provider',
      };
    }
    return cfg.requestsPerDayCap
      ? { limit: cfg.requestsPerDayCap, source: 'configured' }
      : { limit: cfg.fallbackRequestsPerDay, source: 'fallback' };
  }

  /** Today's spend per lane; re-seeds Redis from the database after a flush. */
  async used(credentialId: string, now = Date.now()): Promise<LaneNumbers> {
    const day = utcDay(now);
    const key = this.spendKey(credentialId, day);
    const raw = (await this.redis.client.hgetall(key)) as Record<string, string>;
    const usage = emptyUsage();
    if (raw && Object.keys(raw).length) {
      for (const lane of WATCHFORGE_LANES) usage[lane] = Number(raw[lane] ?? 0) || 0;
      return usage;
    }
    try {
      const rows = await this.prisma.watchForgeUsageDay.findMany({
        where: { day: new Date(day + 'T00:00:00.000Z') },
      });
      for (const row of rows)
        if ((WATCHFORGE_LANES as readonly string[]).includes(row.lane))
          usage[row.lane as WatchForgeLane] = row.requests;
      const seeded = WATCHFORGE_LANES.filter((lane) => usage[lane] > 0);
      if (seeded.length) {
        await this.redis.client.hset(key, ...seeded.flatMap((lane) => [lane, String(usage[lane])]));
        await this.redis.client.expire(key, SPEND_TTL_SEC);
      }
    } catch (error) {
      this.logger.warn(`WatchForge usage reseed failed: ${(error as Error).message}`);
    }
    return usage;
  }

  private async providerWindow(credentialId: string, now: number): Promise<ProviderWindow | null> {
    const window = await this.redis.get<ProviderWindow>(this.windowKey(credentialId));
    return window && window.resetAt > now ? window : null;
  }

  /**
   * Admit one paid request for `lane` and record it. Callers run inside WatchForge's global
   * concurrency slot (default 1), so read-then-increment cannot overshoot meaningfully.
   */
  async admit(
    credentialId: string,
    lane: WatchForgeLane,
    cfg: WatchForgeBudgetConfig,
    now = Date.now(),
  ): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const [{ limit }, used, window] = await Promise.all([
      this.limit(credentialId, cfg),
      this.used(credentialId, now),
      this.providerWindow(credentialId, now),
    ]);
    const backlogReleased = new Date(now).getUTCHours() >= cfg.backlogReleaseHourUtc;
    const providerUsed = window ? Math.max(0, window.limit - window.remaining) : null;
    const allowed = admitWatchForgeLane({
      lane,
      limit,
      used,
      shares: cfg.lanes,
      providerUsed,
      backlogReleased,
    });
    if (!allowed) {
      const resetAt = Math.max(nextUtcMidnight(now), window?.remaining === 0 ? window.resetAt : 0);
      const spent = Math.max(
        WATCHFORGE_LANES.reduce((sum, l) => sum + used[l], 0),
        providerUsed ?? 0,
      );
      const waitForRelease =
        lane === 'backlog' && !backlogReleased && spent < limit && cfg.backlogReleaseHourUtc < 24;
      const releaseAt = Math.floor(now / DAY_MS) * DAY_MS + cfg.backlogReleaseHourUtc * 3_600_000;
      return { allowed: false, retryAfterMs: Math.max(1000, (waitForRelease ? releaseAt : resetAt) - now) };
    }
    const day = utcDay(now);
    const key = this.spendKey(credentialId, day);
    await this.redis.client.hincrby(key, lane, 1);
    await this.redis.client.expire(key, SPEND_TTL_SEC);
    await this.prisma.watchForgeUsageDay
      .upsert({
        where: { day_lane: { day: new Date(day + 'T00:00:00.000Z'), lane } },
        create: { day: new Date(day + 'T00:00:00.000Z'), lane, requests: 1 },
        update: { requests: { increment: 1 } },
      })
      .catch((error: Error) =>
        this.logger.warn(`WatchForge usage mirror failed: ${error.message}`),
      );
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Learn the provider's real daily window from X-RateLimit-* response headers. */
  async observeHeaders(credentialId: string, headers: Headers, now = Date.now()): Promise<void> {
    const limit = Number(headers.get('x-ratelimit-limit'));
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (![limit, remaining, reset].every(Number.isFinite) || limit <= 0 || remaining < 0) return;
    const account = await this.redis.get<{ perDay: number; perMinute: number | null }>(
      this.accountKey(credentialId),
    );
    // Only the daily window matters here; per-minute pacing is enforced by the rate limiter.
    const daily = account?.perDay
      ? limit === account.perDay
      : limit > (account?.perMinute ?? 120);
    if (!daily) return;
    const resetAt = reset > 1e12 ? reset : reset * 1000;
    const ttlSec = Math.ceil(Math.min(DAY_MS, Math.max(1000, resetAt - now)) / 1000);
    await this.redis.set(this.windowKey(credentialId), { limit, remaining, resetAt }, ttlSec);
  }

  async usage(credentialId: string, cfg: WatchForgeBudgetConfig, now = Date.now()) {
    const [{ limit, source }, used, window] = await Promise.all([
      this.limit(credentialId, cfg),
      this.used(credentialId, now),
      this.providerWindow(credentialId, now),
    ]);
    const total = WATCHFORGE_LANES.reduce((sum, lane) => sum + used[lane], 0);
    return {
      day: utcDay(now),
      limit,
      limitSource: source,
      used: total,
      byLane: used,
      shares: cfg.lanes,
      floors: Object.fromEntries(
        WATCHFORGE_LANES.map((lane) => [lane, Math.floor(limit * cfg.lanes[lane])]),
      ) as LaneNumbers,
      backlogReleaseHourUtc: cfg.backlogReleaseHourUtc,
      providerRemaining: window?.remaining ?? null,
      providerResetAt: window ? new Date(window.resetAt).toISOString() : null,
    };
  }
}
