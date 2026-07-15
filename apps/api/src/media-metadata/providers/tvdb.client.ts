import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tvdbCode } from '@tvwatch/shared';
import { currentLanguage } from '../../common/language.context';
import { RedisService } from '../../common/redis/redis.service';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp } from './shared/provider-http';
import { ProviderRateLimiter } from './shared/rate-limiter';
import { ProviderError } from './shared/provider-errors';

interface TvdbTokenCache {
  token: string;
  exp: number;
}

@Injectable()
export class TvdbClient {
  private readonly logger = new Logger(TvdbClient.name);
  private readonly baseUrl = 'https://api4.thetvdb.com/v4';
  readonly apiKey: string | undefined;
  private static readonly TOKEN_KEY = 'TVDB:token';
  private static readonly TOKEN_LOCK = 'tvdb:token';
  /** TVDB tokens last ~30d; refresh a little earlier to be safe. */
  private static readonly TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly SKEW_MS = 60_000;

  constructor(
    config: ConfigService,
    private readonly providerConfig: ProviderConfigService,
    private readonly http: ProviderHttp,
    private readonly redis: RedisService,
    private readonly rateLimiter: ProviderRateLimiter,
  ) {
    this.apiKey = config.get<string>('metadata.tvdbApiKey');
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  artwork(imagePath?: string | null): string | null {
    if (!imagePath) return null;
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    return `https://artworks.thetvdb.com/banners/${imagePath}`;
  }

  /** Ensure a valid bearer token exists, refreshing under a distributed single-flight lock. */
  async ensureToken(): Promise<string> {
    const cached = await this.redis.get<TvdbTokenCache>(TvdbClient.TOKEN_KEY);
    if (cached && cached.exp > Date.now() + TvdbClient.SKEW_MS) return cached.token;

    const result = await this.rateLimiter.distinctLock(TvdbClient.TOKEN_LOCK, 30_000, () => this.refreshToken());
    if (result) return result;
    // Lost the single-flight race — another worker refreshed; read what it wrote.
    const after = await this.redis.get<TvdbTokenCache>(TvdbClient.TOKEN_KEY);
    if (after?.token && after.exp > Date.now() + TvdbClient.SKEW_MS) return after.token;
    throw new Error('TVDB auth unavailable (concurrent refresh failed)');
  }

  private async refreshToken(): Promise<string> {
    const again = await this.redis.get<TvdbTokenCache>(TvdbClient.TOKEN_KEY);
    if (again && again.exp > Date.now() + TvdbClient.SKEW_MS) return again.token;

    const cfg = await this.providerConfig.tvdb();
    const creds = await this.providerConfig.tvdbCredentials();
    if (!creds.apiKey) throw new Error('TVDB not configured');
    const body: Record<string, string> = { apikey: creds.apiKey };
    if (creds.pin) body.pin = creds.pin;

    const json = await this.http.fetchJson<any>({
      provider: 'tvdb',
      config: cfg,
      url: `${this.baseUrl}/login`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const token: string | undefined = json?.data?.token;
    if (!token) throw new Error('TVDB auth: no token in response');
    const exp = Date.now() + TvdbClient.TOKEN_TTL_MS;
    await this.redis.set(TvdbClient.TOKEN_KEY, { token, exp } satisfies TvdbTokenCache, 7 * 24 * 3600);
    this.logger.log('TVDB authenticated (distributed token cached)');
    return token;
  }

  async invalidateToken(): Promise<void> {
    await this.redis.del(TvdbClient.TOKEN_KEY);
  }

  async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    language?: string,
  ): Promise<T> {
    const cfg = await this.providerConfig.tvdb();
    const acceptLanguage = language || tvdbCode(currentLanguage());
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const cacheKey = this.cacheKey(path, acceptLanguage, params);
    const headers = {
      Authorization: `Bearer ${await this.ensureToken()}`,
      Accept: 'application/json',
      'Accept-Language': acceptLanguage,
    };
    try {
      return await this.http.fetchJson<T>({
        provider: 'tvdb',
        config: cfg,
        url: url.toString(),
        headers,
        cacheKey,
      });
    } catch (e) {
      // One controlled retry after an auth failure (token rejected/expired server-side).
      if (e instanceof ProviderError && e.category === 'auth') {
        await this.invalidateToken();
        const headers2 = {
          Authorization: `Bearer ${await this.ensureToken()}`,
          Accept: 'application/json',
          'Accept-Language': acceptLanguage,
        };
        return this.http.fetchJson<T>({
          provider: 'tvdb',
          config: cfg,
          url: url.toString(),
          headers: headers2,
          cacheKey,
        });
      }
      throw e;
    }
  }

  private cacheKey(
    path: string,
    lang: string,
    params: Record<string, string | number | undefined>,
  ): string {
    const sorted = Object.keys(params)
      .sort()
      .filter((k) => {
        const v = params[k];
        return v !== undefined && v !== null && v !== '';
      })
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return `tvdb:${path}:${lang}:${sorted}`;
  }
}
