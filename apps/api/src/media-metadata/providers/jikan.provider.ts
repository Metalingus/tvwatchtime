import { Injectable } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { ProviderConfigService } from './shared/provider-config.service';
import { ProviderHttp } from './shared/provider-http';
import { ProviderError } from './shared/provider-errors';
import type { NormalizedAnime, NormalizedManga } from './normalized-anime';

/**
 * Jikan v4 client (retrieval provider for MyAnimeList). The stored identity is
 * MYANIME_LIST (anime/manga namespaces); Jikan is never stored as an identity.
 *
 * Optional: `enabled` reflects config + local readiness. Failures must degrade
 * gracefully (Kitsu is preferred; Jikan is fallback). JikanBaseUrl points at a
 * self-host instance in prod or the public API as a configurable fallback.
 */
@Injectable()
export class JikanProvider {
  constructor(
    private readonly http: ProviderHttp,
    private readonly config: ProviderConfigService,
  ) {}

  async searchAnime(query: string, limit = 5): Promise<NormalizedAnime[]> {
    const cfg = await this.config.jikan();
    if (!cfg.enabled) throw new ProviderError('upstream', 'jikan disabled', 503);
    const url = `${cfg.baseUrl}/anime?q=${encodeURIComponent(query)}&limit=${limit}&sfw=true`;
    const json = await this.http.fetchJson<any>({ provider: 'jikan', config: cfg, url, cacheKey: `jikan:anime:search:${query}:${limit}` });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((d: any) => this.normalizeAnime(d));
  }

  async getAnime(malId: string): Promise<NormalizedAnime | null> {
    const cfg = await this.config.jikan();
    if (!cfg.enabled) throw new ProviderError('upstream', 'jikan disabled', 503);
    const url = `${cfg.baseUrl}/anime/${malId}`;
    const json = await this.http.fetchJson<any>({ provider: 'jikan', config: cfg, url, cacheKey: `jikan:anime:${malId}` });
    return json?.data ? this.normalizeAnime(json.data) : null;
  }

  async searchManga(query: string, limit = 5): Promise<NormalizedManga[]> {
    const cfg = await this.config.jikan();
    if (!cfg.enabled) throw new ProviderError('upstream', 'jikan disabled', 503);
    const url = `${cfg.baseUrl}/manga?q=${encodeURIComponent(query)}&limit=${limit}&sfw=true`;
    const json = await this.http.fetchJson<any>({ provider: 'jikan', config: cfg, url, cacheKey: `jikan:manga:search:${query}:${limit}` });
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((d: any) => this.normalizeManga(d));
  }

  async getManga(malId: string): Promise<NormalizedManga | null> {
    const cfg = await this.config.jikan();
    if (!cfg.enabled) throw new ProviderError('upstream', 'jikan disabled', 503);
    const url = `${cfg.baseUrl}/manga/${malId}`;
    const json = await this.http.fetchJson<any>({ provider: 'jikan', config: cfg, url, cacheKey: `jikan:manga:${malId}` });
    return json?.data ? this.normalizeManga(json.data) : null;
  }

  private normalizeAnime(d: any): NormalizedAnime {
    return {
      providerEntityKind: 'ANIME',
      malId: d.mal_id != null ? String(d.mal_id) : undefined,
      title: d.title_english || d.title || d.title_japanese || String(d.mal_id),
      canonicalTitle: d.title ?? null,
      alternativeTitles: [d.title, d.title_english, d.title_japanese, ...(d.titles ?? []).map((t: any) => t.title)].filter(
        Boolean,
      ) as string[],
      synopsis: d.synopsis ?? null,
      posterUrl: d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
      coverUrl: d.images?.jpg?.large_image_url ?? null,
      subtype: this.mapSubtype(d.type),
      episodeCount: d.episodes ?? null,
      episodeLength: d.duration ? this.parseDuration(d.duration) : null,
      startDate: d.aired?.from ?? null,
      endDate: d.aired?.to ?? null,
      status: d.status ?? null,
      ageRating: d.rating ?? null,
      genres: (d.genres ?? []).map((g: any) => g.name),
      studios: (d.studios ?? []).map((s: any) => s.name),
    };
  }

  private normalizeManga(d: any): NormalizedManga {
    return {
      providerEntityKind: 'MANGA',
      malId: d.mal_id != null ? String(d.mal_id) : undefined,
      title: d.title_english || d.title || String(d.mal_id),
      canonicalTitle: d.title ?? null,
      alternativeTitles: [d.title, d.title_english, ...(d.titles ?? []).map((t: any) => t.title)].filter(Boolean) as string[],
      synopsis: d.synopsis ?? null,
      posterUrl: d.images?.jpg?.large_image_url ?? d.images?.jpg?.image_url ?? null,
      coverUrl: d.images?.jpg?.large_image_url ?? null,
      subtype: this.mapSubtype(d.type),
      chapterCount: d.chapters ?? null,
      volumeCount: d.volumes ?? null,
      serialization: (d.serializations ?? [])[0]?.name ?? null,
      startDate: d.published?.from ?? null,
      endDate: d.published?.to ?? null,
      status: d.status ?? null,
      genres: (d.genres ?? []).map((g: any) => g.name),
    };
  }

  private mapSubtype(t?: string): string | null {
    if (!t) return null;
    const u = t.toUpperCase();
    if (u === 'TV' || u === 'MOVIE' || u === 'OVA' || u === 'ONA' || u === 'SPECIAL' || u === 'MUSIC') return u;
    if (u === 'MANGA' || u === 'NOVEL' || u === 'MANHWA' || u === 'MANHUA' || u === 'LIGHT NOVEL') return u;
    return u;
  }

  private parseDuration(s: string): number | null {
    const m = s.match(/(\d+)\s*min/);
    return m ? Number(m[1]) : null;
  }

  static readonly identityProvider = ExternalProvider.MYANIME_LIST;
  static readonly animeKind = ProviderEntityKind.ANIME;
  static readonly mangaKind = ProviderEntityKind.MANGA;
}
