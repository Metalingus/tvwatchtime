import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { RedisService } from '../../common/redis/redis.service';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp, ProviderThrottled } from './shared/provider-http';
import { ProviderError } from './shared/provider-errors';
import { ProviderRateLimiter } from './shared/rate-limiter';

export type WatchForgeProvider = 'tmdb' | 'tvdb' | 'imdb' | 'tvtime_uuid';
export interface WatchForgeQuery {
  provider: WatchForgeProvider;
  mediaType: 'tv' | 'movie';
  id: string;
}
export interface WatchForgeIdentity {
  wfId: string;
  mediaType: 'tv' | 'movie';
  title: string;
  year: number | null;
  ids: Record<WatchForgeProvider, string[]>;
  observedAt: string;
  primary?: Record<WatchForgeProvider, string | null>;
}
export type WatchForgeResult =
  | { status: 'found'; identity: WatchForgeIdentity }
  | { status: 'unmapped' }
  | { status: 'conflict'; reason: 'invalid_identity' | 'ambiguous_id' }
  | {
      status: 'deferred';
      reason: 'disabled' | 'unavailable' | 'invalid_response' | 'quota' | 'auth';
      retryAfterMs?: number;
    };

const providers: WatchForgeProvider[] = ['tmdb', 'tvdb', 'imdb', 'tvtime_uuid'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validId(provider: WatchForgeProvider, value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (provider === 'imdb') return /^tt[0-9]+$/.test(value);
  if (provider === 'tvtime_uuid') return uuid.test(value);
  return /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value));
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The catalog supplies identity evidence only; it never owns our metadata or structure. */
@Injectable()
export class WatchForgeClient {
  constructor(
    private readonly config: ProviderConfigService,
    private readonly http: ProviderHttp,
    private readonly limiter: ProviderRateLimiter,
    private readonly redis: RedisService,
  ) {}

  async usage() {
    const cfg = await this.config.watchforge(),
      { apiKey } = await this.config.watchforgeCredentials();
    if (!apiKey)
      return {
        used: 0,
        limit: cfg.requestsPerDay,
        interactiveReserve: cfg.backgroundReserve,
        enabled: false,
      };
    const credentialId = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
    const used = Number(
      await this.redis.client.zcount(
        'RL:watchforge:' + credentialId + ':daily',
        Date.now() - 86400000,
        '+inf',
      ),
    );
    return {
      used,
      limit: cfg.requestsPerDay,
      interactiveReserve: cfg.backgroundReserve,
      enabled: cfg.enabled,
    };
  }

  async lookup(
    query: WatchForgeQuery,
    options: { fresh?: boolean; background?: boolean } = {},
  ): Promise<WatchForgeResult> {
    const result = await this.lookupIdentity(query, options);
    await this.http.metric?.(
      'watchforge',
      'identity_' + result.status + ('reason' in result ? '_' + result.reason : ''),
    );
    return result;
  }

  private async lookupIdentity(
    query: WatchForgeQuery,
    options: { fresh?: boolean; background?: boolean } = {},
  ): Promise<WatchForgeResult> {
    if (
      !providers.includes(query.provider) ||
      !['tv', 'movie'].includes(query.mediaType) ||
      !validId(query.provider, query.id)
    ) {
      return { status: 'conflict', reason: 'invalid_identity' };
    }
    const normalized = {
      ...query,
      id: query.provider === 'tvtime_uuid' ? query.id.toLowerCase() : query.id,
    };
    let pauseKey: string | undefined;
    try {
      const cfg = await this.config.watchforge();
      const { apiKey } = await this.config.watchforgeCredentials();
      if (!cfg.enabled || !apiKey) return { status: 'deferred', reason: 'disabled' };
      const credentialId = createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
      pauseKey = `WF:${credentialId}:pause`;
      const cacheKey = `watchforge:v2:${credentialId}:${normalized.provider}:${normalized.mediaType}:${normalized.id}`;
      // A shared cooldown is an immediate fallback, not a request waiting for admission.
      // Keep cached evidence available, but never wait for the limiter just to reject it.
      const limit = options.background
        ? Math.max(1, cfg.requestsPerDay - (cfg.backgroundReserve ?? 100))
        : cfg.requestsPerDay;
      const budgetPauseKey = pauseKey + ':budget:' + limit;
      const [pause, budgetUntil] = await Promise.all([
        this.redis.get<
          number | { until: number; reason: 'quota' | 'auth' | 'invalid_response' | 'unavailable' }
        >(pauseKey),
        this.redis.get<number>(budgetPauseKey),
      ]);
      const until = Math.max(
        typeof pause === 'number' ? pause : (pause?.until ?? 0),
        budgetUntil ?? 0,
      );
      if (until > Date.now()) {
        if (!options.fresh) {
          const cached = await this.redis.get<WatchForgeIdentity>('PC:' + cacheKey);
          if (cached) return { status: 'found', identity: cached };
          if (await this.redis.get('NC:' + cacheKey)) return { status: 'unmapped' };
        }
        return {
          status: 'deferred',
          reason:
            budgetUntil && budgetUntil > Date.now()
              ? 'quota'
              : typeof pause === 'object'
                ? (pause?.reason ?? 'unavailable')
                : 'unavailable',
          retryAfterMs: until - Date.now(),
        };
      }
      const url = new URL('https://api.watchforge.app/v1/catalog/lookup');
      url.search = new URLSearchParams({
        type: normalized.provider,
        media_type: normalized.mediaType,
        id: normalized.id,
      }).toString();
      const fetchIdentity = () =>
        this.http.fetchJson<WatchForgeIdentity>({
          provider: 'watchforge',
          config: cfg,
          url: url.toString(),
          headers: { Authorization: `Bearer ${apiKey}` },
          cacheKey,
          beforeRequest: async () => {
            const latest = await this.redis.get<number | { until: number }>(pauseKey!);
            const until = typeof latest === 'number' ? latest : latest?.until;
            if (until && until > Date.now())
              throw new ProviderThrottled('watchforge', until - Date.now());
            const budget = await this.limiter.dailyBudget(`watchforge:${credentialId}`, limit);
            if (!budget.allowed) {
              await this.redis.set(
                budgetPauseKey,
                Date.now() + budget.retryAfterMs,
                Math.ceil(budget.retryAfterMs / 1000),
              );
              throw new ProviderThrottled('watchforge', budget.retryAfterMs);
            }
          },
          validate: (value) => this.parse(value, normalized),
        });
      // Existing distinct-lock implementation supplies cross-process single-flight.
      const identity = await this.limiter.distinctLock(
        cacheKey,
        cfg.timeoutMs + 40_000,
        async () => {
          if (options.fresh) await this.redis.client.del(`PC:${cacheKey}`, `NC:${cacheKey}`);
          return fetchIdentity();
        },
      );
      return {
        status: 'found',
        identity: identity === undefined ? await fetchIdentity() : identity,
      };
    } catch (error) {
      if (error instanceof ProviderThrottled)
        return { status: 'deferred', reason: 'quota', retryAfterMs: error.retryAfterMs };
      if (error instanceof ProviderError && error.notFound) return { status: 'unmapped' };
      if (error instanceof ProviderError && error.status === 409) {
        return { status: 'conflict', reason: 'ambiguous_id' };
      }
      const auth = error instanceof ProviderError && [401, 403].includes(error.status ?? 0);
      const quota = error instanceof ProviderError && error.category === 'rate_limited';
      const invalid =
        error instanceof ProviderError && error.category === 'client' && error.status === 502;
      const delay = quota
        ? Math.max(1000, (error as ProviderError).retryAfterMs ?? 60_000)
        : auth
          ? 300_000
          : 30_000;
      if (pauseKey) {
        await this.redis
          .set(
            pauseKey,
            {
              until: Date.now() + delay,
              reason: auth
                ? 'auth'
                : quota
                  ? 'quota'
                  : invalid
                    ? 'invalid_response'
                    : 'unavailable',
            },
            Math.ceil(delay / 1000),
          )
          .catch(() => undefined);
      }
      return {
        status: 'deferred',
        reason: auth ? 'auth' : quota ? 'quota' : invalid ? 'invalid_response' : 'unavailable',
        retryAfterMs: delay,
      };
    }
  }

  private parse(value: unknown, query: WatchForgeQuery): WatchForgeIdentity {
    const invalid = (): never => {
      throw new ProviderError('client', 'Invalid WatchForge identity response', 502);
    };
    if (
      !object(value) ||
      typeof value.wf_id !== 'string' ||
      !/^[1-9][0-9]{0,19}$/.test(value.wf_id) ||
      value.media_type !== query.mediaType ||
      typeof value.title !== 'string' ||
      !value.title.trim()
    ) {
      return invalid();
    }
    if (
      value.year !== undefined &&
      value.year !== null &&
      (typeof value.year !== 'number' || !Number.isSafeInteger(value.year))
    )
      return invalid();
    if (
      value.queried !== undefined &&
      (!object(value.queried) ||
        (value.queried.provider !== query.provider &&
          !(
            query.provider === 'tvtime_uuid' &&
            ['tvtime', 'uuid'].includes(String(value.queried.provider))
          )) ||
        value.queried.media_type !== query.mediaType ||
        String(value.queried.id).toLowerCase() !== query.id.toLowerCase())
    )
      return invalid();
    if (value.ids !== undefined && !object(value.ids)) return invalid();
    const ids = {} as WatchForgeIdentity['ids'];
    const primaryIds = {} as Record<WatchForgeProvider, string | null>;
    for (const provider of providers) {
      const scalar = value[provider];
      if (
        scalar !== null &&
        (scalar === undefined ||
          ((provider === 'tmdb' || provider === 'tvdb') && typeof scalar !== 'number') ||
          !validId(provider, String(scalar)))
      )
        return invalid();
      const primary = scalar === null ? null : String(scalar).toLowerCase();
      primaryIds[provider] = primary;
      const aliases = object(value.ids) ? value.ids[provider] : undefined;
      if (
        aliases !== undefined &&
        (!Array.isArray(aliases) ||
          aliases.length > 32 ||
          !aliases.every((id) => validId(provider, id)))
      )
        return invalid();
      ids[provider] =
        aliases === undefined
          ? primary
            ? [primary]
            : []
          : [...new Set((aliases as string[]).map((id) => id.toLowerCase()))];
      if (primary && !ids[provider].includes(primary)) return invalid();
    }
    if (!ids[query.provider].includes(query.id)) return invalid();
    return {
      wfId: value.wf_id,
      mediaType: query.mediaType,
      title: value.title,
      year: typeof value.year === 'number' ? value.year : null,
      ids,
      observedAt: new Date().toISOString(),
      primary: primaryIds,
    };
  }
}
