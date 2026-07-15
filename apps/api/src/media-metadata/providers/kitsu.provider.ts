import { Injectable } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp } from './shared/provider-http';
import { ProviderError } from './shared/provider-errors';
import type { NormalizedAnime, NormalizedManga } from './normalized-anime';

/**
 * Kitsu client (Option B gateway/cache to the public Kitsu catalogue).
 *
 * IMPORTANT: implemented against the documented Kitsu JSON:API contract at
 * kitsu.app/api/edge. `KITSU_API_MODE` is configurable; if verification at deploy
 * time shows a different supported interface (e.g. GraphQL), this is the single
 * place to adapt. Mobile/web never contact Kitsu directly.
 */
@Injectable()
export class KitsuProvider {
  constructor(
    private readonly http: ProviderHttp,
    private readonly config: ProviderConfigService,
  ) {}

  get enabled(): boolean {
    return true; // final gating via config in each call
  }

  private async cfg() {
    const c = await this.config.kitsu();
    return c;
  }

  private attr(a: any) {
    return a?.attributes ?? {};
  }

  /** Search Kitsu anime by title. Returns normalized candidates with Kitsu ids. */
  async searchAnime(query: string, limit = 5): Promise<NormalizedAnime[]> {
    const cfg = await this.cfg();
    if (!cfg.enabled) throw new ProviderError('upstream', 'kitsu disabled', 503);
    const url = `${cfg.baseUrl}/anime?filter[text]=${encodeURIComponent(query)}&page[limit]=${limit}`;
    const json = await this.http.fetchJson<any>({ provider: 'kitsu', config: cfg, url, cacheKey: `kitsu:anime:search:${query}:${limit}` });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((d: any) => this.normalizeAnime(d));
  }

  async getAnime(kitsuId: string): Promise<NormalizedAnime | null> {
    const cfg = await this.cfg();
    if (!cfg.enabled) throw new ProviderError('upstream', 'kitsu disabled', 503);
    const url = `${cfg.baseUrl}/anime/${kitsuId}`;
    const json = await this.http.fetchJson<any>({ provider: 'kitsu', config: cfg, url, cacheKey: `kitsu:anime:${kitsuId}` });
    return json?.data ? this.normalizeAnime(json.data) : null;
  }

  /** Search Kitsu manga by title (internal identification only). */
  async searchManga(query: string, limit = 5): Promise<NormalizedManga[]> {
    const cfg = await this.cfg();
    if (!cfg.enabled) throw new ProviderError('upstream', 'kitsu disabled', 503);
    const url = `${cfg.baseUrl}/manga?filter[text]=${encodeURIComponent(query)}&page[limit]=${limit}`;
    const json = await this.http.fetchJson<any>({ provider: 'kitsu', config: cfg, url, cacheKey: `kitsu:manga:search:${query}:${limit}` });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((d: any) => this.normalizeManga(d));
  }

  async getManga(kitsuId: string): Promise<NormalizedManga | null> {
    const cfg = await this.cfg();
    if (!cfg.enabled) throw new ProviderError('upstream', 'kitsu disabled', 503);
    const url = `${cfg.baseUrl}/manga/${kitsuId}`;
    const json = await this.http.fetchJson<any>({ provider: 'kitsu', config: cfg, url, cacheKey: `kitsu:manga:${kitsuId}` });
    return json?.data ? this.normalizeManga(json.data) : null;
  }

  private normalizeAnime(d: any): NormalizedAnime {
    const a = this.attr(d);
    const titles = a.titles ?? {};
    return {
      providerEntityKind: 'ANIME',
      kitsuId: String(d.id),
      malId: a.malId ? String(a.malId) : undefined,
      title: a.canonicalTitle || titles.en || titles.en_jp || d.id,
      canonicalTitle: a.canonicalTitle ?? null,
      alternativeTitles: Object.values(titles).filter(Boolean) as string[],
      synopsis: a.synopsis ?? null,
      posterUrl: a.posterImage?.original ?? null,
      coverUrl: a.coverImage?.original ?? null,
      subtype: a.subtype ?? null,
      episodeCount: a.episodeCount ?? null,
      episodeLength: a.episodeLength ?? null,
      startDate: a.startDate ?? null,
      endDate: a.endDate ?? null,
      status: a.status ?? null,
      ageRating: a.ageRating ?? null,
    };
  }

  private normalizeManga(d: any): NormalizedManga {
    const a = this.attr(d);
    const titles = a.titles ?? {};
    return {
      providerEntityKind: 'MANGA',
      kitsuId: String(d.id),
      malId: a.malId ? String(a.malId) : undefined,
      title: a.canonicalTitle || titles.en || d.id,
      canonicalTitle: a.canonicalTitle ?? null,
      alternativeTitles: Object.values(titles).filter(Boolean) as string[],
      synopsis: a.synopsis ?? null,
      posterUrl: a.posterImage?.original ?? null,
      coverUrl: a.coverImage?.original ?? null,
      subtype: a.subtype ?? null,
      chapterCount: a.chapterCount ?? null,
      volumeCount: a.volumeCount ?? null,
      serialization: a.serialization ?? null,
      startDate: a.startDate ?? null,
      endDate: a.endDate ?? null,
      status: a.status ?? null,
    };
  }

  static readonly identityProvider = ExternalProvider.KITSU;
  static readonly animeKind = ProviderEntityKind.ANIME;
  static readonly mangaKind = ProviderEntityKind.MANGA;
}
