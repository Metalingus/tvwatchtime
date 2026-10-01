import { Injectable, Logger } from '@nestjs/common';
import {
  STREAMING_TOP_COUNTRIES,
  STREAMING_TOP_SERVICES,
  type StreamingTopService,
} from '@tvwatch/shared';
import { RedisService } from '../../common/redis/redis.service';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp, ProviderThrottled } from './shared/provider-http';
import { ProviderError } from './shared/provider-errors';

/** Chart countries an admin can pick (shared with the admin console). */
export const MOTN_CHART_COUNTRIES = STREAMING_TOP_COUNTRIES;

export interface MotnTopItem {
  kind: 'SHOW' | 'MOVIE';
  tmdbId: number;
  imdbId: string | null;
  title: string;
  year: number | null;
  /** Streaming option types for the requested service in the requested country. */
  optionTypes: string[];
}

export interface MotnTopList {
  items: MotnTopItem[];
  /** Items dropped by validation (bad ids, kind mismatch). */
  dropped: number;
}

export interface MotnQuota {
  used: number;
  granted: number;
  remaining: number;
  resetAt: string | null;
  observedAt: string;
}

const QUOTA_KEY = 'MOTN:quota';

function int(value: string | null): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** x-quota-reset is ISO-8601 today; epoch seconds/ms and relative seconds are tolerated. */
export function parseQuotaReset(value: string | null, now = Date.now()): string | null {
  if (!value) return null;
  const n = Number(value);
  if (Number.isFinite(n) && value.trim() !== '') {
    const ms = n > 1e12 ? n : n > 1e9 ? n * 1000 : now + n * 1000;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Strict parse of GET /shows/top: anything that cannot be matched by id is dropped. */
export function parseTopShows(
  value: unknown,
  country: string,
  service: StreamingTopService,
): MotnTopList {
  if (!Array.isArray(value)) throw new ProviderError('client', 'motn invalid top list', 502);
  const cc = country.toLowerCase();
  const items: MotnTopItem[] = [];
  let dropped = 0;
  for (const raw of value) {
    const row = raw && typeof raw === 'object' ? (raw as Record<string, any>) : null;
    const showType = row?.showType;
    const tmdb =
      typeof row?.tmdbId === 'string' ? /^(movie|tv)\/([1-9][0-9]*)$/.exec(row.tmdbId) : null;
    const kind = showType === 'movie' ? 'MOVIE' : showType === 'series' ? 'SHOW' : null;
    const tmdbId = tmdb ? Number(tmdb[2]) : NaN;
    if (
      !kind ||
      !tmdb ||
      (tmdb[1] === 'movie') !== (kind === 'MOVIE') ||
      !Number.isSafeInteger(tmdbId) ||
      typeof row?.title !== 'string'
    ) {
      dropped++;
      continue;
    }
    const imdbId =
      typeof row.imdbId === 'string' && /^tt[0-9]+$/.test(row.imdbId) ? row.imdbId : null;
    const yearRaw = kind === 'MOVIE' ? row.releaseYear : (row.firstAirYear ?? row.releaseYear);
    const options = Array.isArray(row.streamingOptions?.[cc]) ? row.streamingOptions[cc] : [];
    const optionTypes = [
      ...new Set<string>(
        options
          .filter((o: any) => o?.service?.id === service && typeof o?.type === 'string')
          .map((o: any) => o.type as string),
      ),
    ];
    items.push({
      kind,
      tmdbId,
      imdbId,
      title: row.title,
      year: Number.isInteger(yearRaw) ? yearRaw : null,
      optionTypes,
    });
  }
  return { items, dropped };
}

/** Movie of the Night client. Chart data only; it never supplies metadata or identity. */
@Injectable()
export class MotnClient {
  private readonly logger = new Logger(MotnClient.name);

  constructor(
    private readonly config: ProviderConfigService,
    private readonly http: ProviderHttp,
    private readonly redis: RedisService,
  ) {}

  async configured(): Promise<boolean> {
    return (await this.config.motn()).enabled;
  }

  /** Official top chart of one service. One paid request per (country, service, UTC day). */
  async topShows(country: string, service: StreamingTopService): Promise<MotnTopList> {
    if (!(STREAMING_TOP_SERVICES as readonly string[]).includes(service))
      throw new ProviderError('client', `motn unsupported service ${service}`, 400);
    const cc = country.toUpperCase();
    const cfg = await this.config.motn();
    const { apiKey } = await this.config.motnCredentials();
    if (!cfg.enabled || !apiKey) throw new ProviderError('upstream', 'motn disabled', 503);
    const url = new URL(`${cfg.baseUrl ?? 'https://api.movieofthenight.com/v4'}/shows/top`);
    url.search = new URLSearchParams({ country: cc.toLowerCase(), service }).toString();
    return this.http.fetchJson<MotnTopList>({
      provider: 'motn',
      config: cfg,
      url: url.toString(),
      headers: { 'X-API-Key': apiKey, Accept: 'application/json' },
      cacheKey: `motn:top:v1:${cc}:${service}:${new Date().toISOString().slice(0, 10)}`,
      beforeRequest: async () => {
        // The quota is a hard cap: once it is spent every call fails until the reset.
        const quota = await this.quota();
        if (quota && quota.remaining <= 0 && quota.resetAt) {
          const wait = Date.parse(quota.resetAt) - Date.now();
          if (wait > 0) throw new ProviderThrottled('motn', wait);
        }
      },
      onResponse: (headers) => this.observeQuota(headers),
      validate: (value) => parseTopShows(value, cc, service),
    });
  }

  async quota(): Promise<MotnQuota | null> {
    return this.redis.get<MotnQuota>(QUOTA_KEY).catch(() => null);
  }

  async observeQuota(headers: Headers): Promise<void> {
    const used = int(headers.get('x-quota-used'));
    const granted = int(headers.get('x-quota-granted'));
    if (used == null || granted == null) return;
    const resetAt = parseQuotaReset(headers.get('x-quota-reset'));
    const quota: MotnQuota = {
      used,
      granted,
      remaining: Math.max(0, granted - used),
      resetAt,
      observedAt: new Date().toISOString(),
    };
    const ttl = resetAt
      ? Math.max(60, Math.ceil((Date.parse(resetAt) - Date.now()) / 1000))
      : 31 * 86400;
    await this.redis.set(QUOTA_KEY, quota, ttl).catch((error) => {
      this.logger.warn(`MOTN quota observation not stored: ${(error as Error).message}`);
    });
  }
}
