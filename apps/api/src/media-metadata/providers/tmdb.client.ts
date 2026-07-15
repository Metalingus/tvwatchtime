import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { tmdbCode } from '@tvwatch/shared';
import { currentLanguage } from '../../common/language.context';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp } from './shared/provider-http';

export interface TmdbResponse<T> {
  page?: number;
  total_pages?: number;
  total_results?: number;
  results?: T[];
}

@Injectable()
export class TmdbClient {
  private readonly logger = new Logger(TmdbClient.name);
  private readonly baseUrl = 'https://api.themoviedb.org/3';
  readonly imageBase = 'https://image.tmdb.org/t/p';
  readonly apiKey: string | undefined;
  readonly language: string;

  constructor(
    config: ConfigService,
    private readonly providerConfig: ProviderConfigService,
    private readonly http: ProviderHttp,
  ) {
    this.apiKey = config.get<string>('metadata.tmdbApiKey');
    this.language = config.get<string>('metadata.tmdbLanguage') || 'en-US';
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  img(path?: string | null, size = 'w500'): string | null {
    return path ? `${this.imageBase}/${size}${path}` : null;
  }

  async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
    language?: string,
  ): Promise<T> {
    if (!this.apiKey) throw new Error('TMDb not configured');
    const cfg = await this.providerConfig.tmdb();
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('api_key', this.apiKey);
    // Per-request language: explicit override > request locale > server-wide default.
    const lang = language || tmdbCode(currentLanguage()) || this.language;
    url.searchParams.set('language', lang);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const cacheKey = this.cacheKey(path, lang, params);
    return this.http.fetchJson<T>({
      provider: 'tmdb',
      config: cfg,
      url: url.toString(),
      cacheKey,
    });
  }

  private cacheKey(
    path: string,
    lang: string,
    params: Record<string, string | number | boolean | undefined>,
  ): string {
    const sorted = Object.keys(params)
      .sort()
      .filter((k) => {
        const v = params[k];
        return v !== undefined && v !== null && v !== '';
      })
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return `tmdb:${path}:${lang}:${sorted}`;
  }
}
