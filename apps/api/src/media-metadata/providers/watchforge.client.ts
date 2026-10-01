import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.service';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp, ProviderThrottled } from './shared/provider-http';
import { ProviderError } from './shared/provider-errors';
import { ProviderRateLimiter } from './shared/rate-limiter';
import {
  WatchForgeBudget,
  type WatchForgeLane,
  watchForgeCredentialId,
} from './watchforge-budget.service';
import { WATCHFORGE_LEDGER_TTL_MS, WatchForgeLedger } from './watchforge-ledger.service';

export type { WatchForgeLane } from './watchforge-budget.service';

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

/** How long a locally failed lookup (slot timeout) waits before callers retry. */
const LOCAL_RETRY_MS = 5_000;
/** Minimum spacing between WatchForge /me account-limit refreshes. */
const ACCOUNT_REFRESH_BACKOFF_SEC = 900;

export interface WatchForgeLookupOptions {
  /** Budget lane that pays for a new request (default: repair). */
  lane?: WatchForgeLane;
  /** Bypass cached outcomes and pay again. Reserved for explicit operator re-verification. */
  fresh?: boolean;
}

/** The catalog supplies identity evidence only; it never owns our metadata or structure. */
@Injectable()
export class WatchForgeClient {
  private readonly logger = new Logger(WatchForgeClient.name);

  constructor(
    private readonly config: ProviderConfigService,
    private readonly http: ProviderHttp,
    private readonly limiter: ProviderRateLimiter,
    private readonly redis: RedisService,
    private readonly budget: WatchForgeBudget,
    private readonly ledger: WatchForgeLedger,
  ) {}

  async usage() {
    const cfg = await this.config.watchforge(),
      { apiKey } = await this.config.watchforgeCredentials();
    if (!apiKey) return { enabled: false, configured: false };
    const credentialId = watchForgeCredentialId(apiKey);
    await this.refreshAccountLimit(cfg, apiKey, credentialId);
    return {
      enabled: cfg.enabled,
      configured: true,
      ...(await this.budget.usage(credentialId, cfg)),
    };
  }

  async lookup(
    query: WatchForgeQuery,
    options: WatchForgeLookupOptions = {},
  ): Promise<WatchForgeResult> {
    const result = await this.lookupIdentity(query, options);
    await this.http.metric?.(
      'watchforge',
      'identity_' + result.status + ('reason' in result ? '_' + result.reason : ''),
    );
    return result;
  }

  /** Answer from a previous paid lookup (Redis payload cache, then the durable ledger). */
  private async remembered(
    cacheKey: string,
    query: WatchForgeQuery,
  ): Promise<WatchForgeResult | null> {
    const cached = await this.redis.get<WatchForgeIdentity>('PC:' + cacheKey);
    if (cached) return { status: 'found', identity: cached };
    if (await this.redis.get('NC:' + cacheKey)) return { status: 'unmapped' };
    const known = await this.ledger.recall(query);
    if (!known) return null;
    if (known.outcome === 'unmapped') return { status: 'unmapped' };
    if (known.outcome === 'ambiguous') return { status: 'conflict', reason: 'ambiguous_id' };
    if (known.outcome === 'invalid')
      return {
        status: 'deferred',
        reason: 'invalid_response',
        retryAfterMs: Math.max(1000, known.expiresAt.getTime() - Date.now()),
      };
    return null; // `found` without a cached payload must be looked up again
  }

  /** Keep the account's real daily limit current (WatchForge /me), at most every 6 hours. */
  private async refreshAccountLimit(
    cfg: Awaited<ReturnType<ProviderConfigService['watchforge']>>,
    apiKey: string,
    credentialId: string,
  ): Promise<void> {
    if (!cfg.enabled || (await this.budget.hasFreshAccountLimit(credentialId))) return;
    const claimed = await this.redis.client
      .set(`WF:${credentialId}:account-refresh`, '1', 'EX', ACCOUNT_REFRESH_BACKOFF_SEC, 'NX')
      .catch(() => null);
    if (claimed !== 'OK') return;
    try {
      const me = await this.http.fetchJson<{
        rate_limit?: { per_day?: number; per_minute?: number };
      }>({
        provider: 'watchforge',
        config: cfg,
        url: 'https://api.watchforge.app/v1/me',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const perMinute = Number(me?.rate_limit?.per_minute);
      await this.budget.setAccountLimit(
        credentialId,
        Number(me?.rate_limit?.per_day),
        Number.isFinite(perMinute) ? perMinute : null,
      );
    } catch (error) {
      this.logger.warn(`WatchForge account limit refresh failed: ${(error as Error).message}`);
    }
  }

  private async lookupIdentity(
    query: WatchForgeQuery,
    options: WatchForgeLookupOptions = {},
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
    const lane: WatchForgeLane = options.lane ?? 'repair';
    let pauseKey: string | undefined;
    try {
      const cfg = await this.config.watchforge();
      const { apiKey } = await this.config.watchforgeCredentials();
      if (!cfg.enabled || !apiKey) return { status: 'deferred', reason: 'disabled' };
      const credentialId = watchForgeCredentialId(apiKey);
      pauseKey = `WF:${credentialId}:pause`;
      const cacheKey = `watchforge:v2:${credentialId}:${normalized.provider}:${normalized.mediaType}:${normalized.id}`;
      // Never pay twice for an identifier whose outcome is still known.
      if (!options.fresh) {
        const known = await this.remembered(cacheKey, normalized);
        if (known) return known;
      }
      // A shared cooldown is an immediate fallback, not a request waiting for admission.
      const laneBudgetKey = `WF:${credentialId}:pause:budget:${lane}`;
      const [pause, budgetUntil] = await Promise.all([
        this.redis.get<
          number | { until: number; reason: 'quota' | 'auth' | 'invalid_response' | 'unavailable' }
        >(pauseKey),
        this.redis.get<number>(laneBudgetKey),
      ]);
      const until = Math.max(
        typeof pause === 'number' ? pause : (pause?.until ?? 0),
        budgetUntil ?? 0,
      );
      if (until > Date.now()) {
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
      await this.refreshAccountLimit(cfg, apiKey, credentialId);
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
            const pausedUntil = typeof latest === 'number' ? latest : latest?.until;
            if (pausedUntil && pausedUntil > Date.now())
              throw new ProviderThrottled('watchforge', pausedUntil - Date.now());
            const admission = await this.budget.admit(credentialId, lane, cfg);
            if (!admission.allowed) {
              await this.redis.set(
                laneBudgetKey,
                Date.now() + admission.retryAfterMs,
                Math.ceil(admission.retryAfterMs / 1000),
              );
              throw new ProviderThrottled('watchforge', admission.retryAfterMs);
            }
          },
          onResponse: (headers) => this.budget.observeHeaders(credentialId, headers),
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
      if (identity === undefined) {
        // Another worker held the lock and paid; reuse its outcome instead of paying again.
        return (
          (await this.remembered(cacheKey, normalized)) ?? {
            status: 'deferred',
            reason: 'unavailable',
            retryAfterMs: LOCAL_RETRY_MS,
          }
        );
      }
      await this.ledger.record(normalized, 'found', lane, identity.wfId);
      return { status: 'found', identity };
    } catch (error) {
      if (error instanceof ProviderThrottled)
        return { status: 'deferred', reason: 'quota', retryAfterMs: error.retryAfterMs };
      if (error instanceof ProviderError && error.notFound) {
        await this.ledger.record(normalized, 'unmapped', lane);
        return { status: 'unmapped' };
      }
      if (error instanceof ProviderError && error.status === 409) {
        await this.ledger.record(normalized, 'ambiguous', lane);
        return { status: 'conflict', reason: 'ambiguous_id' };
      }
      if (error instanceof ProviderError && error.category === 'client' && error.status === 502) {
        // One malformed record is quarantined for that identifier only; other lookups continue.
        await this.ledger.record(normalized, 'invalid', lane);
        return {
          status: 'deferred',
          reason: 'invalid_response',
          retryAfterMs: WATCHFORGE_LEDGER_TTL_MS.invalid,
        };
      }
      if (!(error instanceof ProviderError)) {
        // Local failures (e.g. waiting for the concurrency slot) say nothing about WatchForge.
        return { status: 'deferred', reason: 'unavailable', retryAfterMs: LOCAL_RETRY_MS };
      }
      const auth = [401, 403].includes(error.status ?? 0);
      const quota = error.category === 'rate_limited';
      const delay = quota ? Math.max(1000, error.retryAfterMs ?? 60_000) : auth ? 300_000 : 30_000;
      if (pauseKey) {
        await this.redis
          .set(
            pauseKey,
            { until: Date.now() + delay, reason: auth ? 'auth' : quota ? 'quota' : 'unavailable' },
            Math.ceil(delay / 1000),
          )
          .catch(() => undefined);
      }
      return {
        status: 'deferred',
        reason: auth ? 'auth' : quota ? 'quota' : 'unavailable',
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
