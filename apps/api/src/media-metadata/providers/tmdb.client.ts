import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

  // Global (per-process) rate limiting — single chokepoint for ALL TMDb calls (app + import).
  private readonly rps: number;
  private readonly minIntervalMs: number;
  private lastCallAt = 0;
  private chain: Promise<void> = Promise.resolve();
  private readonly MAX_RETRIES = 4;
  private readonly BASE_BACKOFF_MS = 500;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('metadata.tmdbApiKey');
    this.language = config.get<string>('metadata.tmdbLanguage') || 'en-US';
    this.rps = Math.max(1, Number(config.get<number>('metadata.tmdbRps') ?? 40));
    this.minIntervalMs = Math.ceil(1000 / this.rps);
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  img(path?: string | null, size = 'w500'): string | null {
    return path ? `${this.imageBase}/${size}${path}` : null;
  }

  /** Serialize calls so the global RPS ceiling holds across concurrent callers. */
  private reserve(): Promise<void> {
    const next = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private parseRetryAfter(res: Response): number | null {
    const h = res.headers.get('retry-after');
    if (!h) return null;
    const secs = Number(h);
    if (Number.isFinite(secs)) return secs * 1000;
    const date = Date.parse(h);
    return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
  }

  async get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
    if (!this.apiKey) throw new ServiceUnavailableException('TMDb not configured');
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('api_key', this.apiKey);
    url.searchParams.set('language', this.language);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.MAX_RETRIES; attempt++) {
      await this.reserve();
      let res: Response;
      try {
        res = await fetch(url.toString());
      } catch (e) {
        lastErr = e;
        await this.backoff(attempt, null);
        continue;
      }

      if (res.status === 429 || res.status >= 500) {
        const retryAfter = this.parseRetryAfter(res);
        if (attempt === this.MAX_RETRIES) {
          this.logger.warn(`TMDb ${path} -> ${res.status} (giving up after ${attempt} retries)`);
          throw new ServiceUnavailableException(`TMDb rate-limited/unavailable (${res.status})`);
        }
        this.logger.warn(`TMDb ${path} -> ${res.status}; backing off ${retryAfter ?? 'exp'} (attempt ${attempt + 1})`);
        await this.backoff(attempt, retryAfter);
        continue;
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`TMDb ${path} -> ${res.status}: ${body.slice(0, 200)}`);
        throw new ServiceUnavailableException(`TMDb error ${res.status}`);
      }
      return res.json() as Promise<T>;
    }
    throw lastErr instanceof Error ? lastErr : new ServiceUnavailableException('TMDb unavailable');
  }

  private backoff(attempt: number, retryAfterMs: number | null): Promise<void> {
    const exp = this.BASE_BACKOFF_MS * 2 ** attempt + Math.floor(Math.random() * 150); // jitter
    const delay = retryAfterMs != null ? retryAfterMs : Math.min(exp, 30_000);
    return new Promise((r) => setTimeout(r, delay));
  }
}
