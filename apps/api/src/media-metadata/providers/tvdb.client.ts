import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TvdbClient {
  private readonly logger = new Logger(TvdbClient.name);
  private readonly baseUrl = 'https://api4.thetvdb.com/v4';
  readonly apiKey: string | undefined;

  private token: string | null = null;
  private tokenExpiresAt = 0;

  private readonly rps: number;
  private readonly minIntervalMs: number;
  private lastCallAt = 0;
  private chain: Promise<void> = Promise.resolve();

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('metadata.tvdbApiKey');
    this.rps = Number(config.get<number>('metadata.tvdbRps') ?? 10);
    this.minIntervalMs = this.rps > 0 ? Math.ceil(1000 / this.rps) : 0; // 0 = unlimited
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  artwork(imagePath?: string | null): string | null {
    if (!imagePath) return null;
    // The TVDB API sometimes returns absolute artwork URLs (already including the
    // banners host). Only prefix relative paths to avoid a doubled host.
    if (/^https?:\/\//i.test(imagePath)) return imagePath;
    return `https://artworks.thetvdb.com/banners/${imagePath}`;
  }

  private reserve(): Promise<void> {
    if (this.minIntervalMs === 0) return Promise.resolve();
    const next = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastCallAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCallAt = Date.now();
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async ensureToken(): Promise<void> {
    if (this.token && Date.now() < this.tokenExpiresAt) return;
    if (!this.apiKey) throw new ServiceUnavailableException('TVDB not configured');

    await this.reserve();
    const res = await fetch(`${this.baseUrl}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apikey: this.apiKey }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new ServiceUnavailableException(`TVDB auth failed: ${res.status} ${body.slice(0, 200)}`);
    }
    const json: any = await res.json();
    this.token = json.data?.token;
    if (!this.token) throw new ServiceUnavailableException('TVDB auth: no token in response');
    this.tokenExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
    this.logger.log('TVDB authenticated');
  }

  async get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    await this.ensureToken();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.reserve();
      try {
        const res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        });
        if (res.status === 401) {
          this.token = null;
          this.tokenExpiresAt = 0;
          await this.ensureToken();
          continue;
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers.get('retry-after') || '5');
          await new Promise((r) => setTimeout(r, retryAfter * 1000));
          continue;
        }
        if (!res.ok) {
          const body = await res.text();
          this.logger.warn(`TVDB ${path} → ${res.status}: ${body.slice(0, 200)}`);
          throw new ServiceUnavailableException(`TVDB error: ${res.status}`);
        }
        return (await res.json()) as T;
      } catch (e) {
        if (e instanceof ServiceUnavailableException && attempt === 2) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    throw lastErr ?? new ServiceUnavailableException('TVDB request failed');
  }
}
