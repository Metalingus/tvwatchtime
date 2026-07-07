import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TvEpisode {
  season: number;
  number: number;
  airtime: string | null;
  airstamp: string | null;
}

@Injectable()
export class TvmazeProvider {
  private readonly logger = new Logger(TvmazeProvider.name);
  private readonly base = 'https://api.tvmaze.com';
  private readonly showCache = new Map<string, number | null>();
  readonly enabled: boolean;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('metadata.tvmazeEnabled') !== false;
  }

  private async fetchJson(url: string): Promise<any | null> {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (res.status === 404) return null;
      if (!res.ok) {
        this.logger.warn(`TVmaze ${url} -> ${res.status}`);
        return null;
      }
      return res.json();
    } catch (e) {
      this.logger.debug(`TVmaze fetch failed: ${(e as Error).message}`);
      return null;
    }
  }

  private async findShowId(tvdb?: string, imdb?: string): Promise<number | null> {
    const key = `${tvdb ?? ''}|${imdb ?? ''}`;
    if (this.showCache.has(key)) return this.showCache.get(key)!;
    let show: any = null;
    if (tvdb) show = await this.fetchJson(`${this.base}/lookup/shows?thetvdb=${encodeURIComponent(tvdb)}`);
    if (!show && imdb) show = await this.fetchJson(`${this.base}/lookup/shows?imdb=${encodeURIComponent(imdb)}`);
    const id = show?.id ?? null;
    this.showCache.set(key, id);
    return id;
  }

  /** Returns a map "seasonNumber-episodeNumber" -> { airtime, airstamp }. */
  async getEpisodeAirTimes(tvdb?: string, imdb?: string): Promise<Map<string, TvEpisode>> {
    const out = new Map<string, TvEpisode>();
    if (!this.enabled || (!tvdb && !imdb)) return out;
    const showId = await this.findShowId(tvdb, imdb);
    if (!showId) return out;
    const eps = (await this.fetchJson(`${this.base}/shows/${showId}/episodes`)) as TvEpisode[] | null;
    if (!Array.isArray(eps)) return out;
    for (const e of eps) {
      if (e && typeof e.season === 'number' && typeof e.number === 'number') {
        out.set(`${e.season}-${e.number}`, e);
      }
    }
    return out;
  }
}
