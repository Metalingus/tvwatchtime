import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { cleanExternalIds, isoOrNull, providerJson } from './provider-http';
import type { InboundSyncItem, ProviderSyncPayload } from './types';

const CLIENT_AUTH =
  'MediaBrowser Client="TVWatch", Device="Server", DeviceId="tvwatch-integration", Version="0.1.0"';

type JellyfinItem = {
  Id?: string;
  Name?: string;
  Type?: 'Movie' | 'Episode' | 'Series' | 'BoxSet' | string;
  SeriesId?: string;
  SeriesName?: string;
  ProductionYear?: number;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProviderIds?: Record<string, string>;
  UserData?: {
    Played?: boolean;
    IsFavorite?: boolean;
    DatePlayed?: string | null;
  };
};

type JellyfinCredentials = {
  serverUrl: string;
  accessToken: string;
  userId: string;
};

type JellyfinMediaLookup = {
  mediaType: 'MOVIE' | 'SHOW';
  title: string;
  year?: number | null;
  ids?: { imdb?: string; tmdb?: number; tvdb?: number };
};

export function isPrivateAddress(address: string): boolean {
  const ipv6 = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const normalized = ipv6.replace(/^::ffff:/, '');
  if (normalized === '::' || normalized === '::1' || normalized === '0.0.0.0') return true;
  if (
    /^(fc|fd)/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized) ||
    /^2001:db8(?::|$)/.test(normalized)
  )
    return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] >= 224
  );
}

export function normalizeJellyfinUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException('Jellyfin server URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new BadRequestException('Jellyfin server URL is invalid');
  }
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export function jellyfinItemIdFromSourceKey(sourceKey: string): string | null {
  const patterns = [
    /^movie:([^:]+):/,
    /^series:([^:]+):(?:favorite|watchlist)$/,
    /^series:([^:]+):episode:/,
    /^boxset:[^:]+:item:([^:]+)$/,
  ];
  for (const pattern of patterns) {
    const match = sourceKey.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function jellyfinWebUrl(serverUrl: string, itemId?: string | null): string {
  const baseUrl = normalizeJellyfinUrl(serverUrl);
  return itemId ? `${baseUrl}/web/#/details?id=${encodeURIComponent(itemId)}` : baseUrl;
}

@Injectable()
export class JellyfinClient {
  constructor(private readonly config: ConfigService) {}

  private async assertAllowed(serverUrl: string) {
    if (this.config.get<boolean>('integrations.allowPrivateUrls')) return;
    const url = new URL(serverUrl);
    if (url.protocol !== 'https:') {
      throw new BadRequestException('Public Jellyfin URLs must use HTTPS');
    }
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/\.$/, '');
    if (hostname === 'localhost' || hostname.endsWith('.local')) {
      throw new BadRequestException('Private Jellyfin URLs are disabled on this server');
    }
    const addresses = isIP(hostname)
      ? [{ address: hostname }]
      : await lookup(hostname, { all: true }).catch(() => []);
    if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new BadRequestException('Private Jellyfin URLs are disabled on this server');
    }
  }

  private endpoint(serverUrl: string, path: string): string {
    return `${serverUrl}${path}`;
  }

  private async fetchItems(
    credentials: JellyfinCredentials,
    parameters: Record<string, string>,
  ): Promise<JellyfinItem[]> {
    const all: JellyfinItem[] = [];
    const limit = 1000;
    for (let start = 0; ; start += limit) {
      const query = new URLSearchParams({
        ...parameters,
        EnableTotalRecordCount: 'true',
        StartIndex: String(start),
        Limit: String(limit),
      });
      const response = await providerJson<{ Items?: JellyfinItem[]; TotalRecordCount?: number }>(
        'Jellyfin',
        this.endpoint(
          credentials.serverUrl,
          `/Users/${encodeURIComponent(credentials.userId)}/Items?${query.toString()}`,
        ),
        {
          headers: {
            'X-Emby-Authorization': `${CLIENT_AUTH}, Token=\u0022${credentials.accessToken}\u0022`,
            'X-Emby-Token': credentials.accessToken,
          },
          redirect: 'error',
        },
      );
      const page = response.Items ?? [];
      all.push(...page);
      if (page.length < limit || all.length >= Number(response.TotalRecordCount ?? 0)) break;
    }
    return all;
  }

  async connect(serverUrlInput: string, username: string, password: string) {
    const serverUrl = normalizeJellyfinUrl(serverUrlInput);
    await this.assertAllowed(serverUrl);
    const response = await providerJson<any>(
      'Jellyfin',
      this.endpoint(serverUrl, '/Users/AuthenticateByName'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': CLIENT_AUTH,
        },
        body: JSON.stringify({ Username: username, Pw: password }),
        redirect: 'error',
      },
    );
    const token = response.AccessToken;
    const userId = response.User?.Id;
    if (!token || !userId) throw new BadRequestException('Jellyfin login failed');
    return {
      serverUrl,
      accessToken: String(token),
      userId: String(userId),
      displayName: String(response.User?.Name ?? username),
    };
  }

  async findLibraryItemId(
    credentials: JellyfinCredentials,
    target: JellyfinMediaLookup,
  ): Promise<string | null> {
    await this.assertAllowed(credentials.serverUrl);
    const candidates = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: target.mediaType === 'MOVIE' ? 'Movie' : 'Series',
      Fields: 'ProviderIds',
      SearchTerm: target.title,
    });
    const targetIds = target.ids ?? {};
    const externalMatch = candidates.find((candidate) => {
      if (!candidate.Id) return false;
      const ids = cleanExternalIds(candidate.ProviderIds);
      return Boolean(
        (targetIds.imdb && ids.imdb?.toLowerCase() === targetIds.imdb.toLowerCase()) ||
        (targetIds.tmdb && ids.tmdb === targetIds.tmdb) ||
        (targetIds.tvdb && ids.tvdb === targetIds.tvdb),
      );
    });
    if (externalMatch?.Id) return externalMatch.Id;

    const title = target.title.trim().toLocaleLowerCase();
    const titleMatch = candidates.find((candidate) => {
      if (!candidate.Id || candidate.Name?.trim().toLocaleLowerCase() !== title) return false;
      return !target.year || !candidate.ProductionYear || candidate.ProductionYear === target.year;
    });
    return titleMatch?.Id ?? null;
  }

  async sync(credentials: JellyfinCredentials): Promise<ProviderSyncPayload> {
    await this.assertAllowed(credentials.serverUrl);
    const all: JellyfinItem[] = [];
    const limit = 1000;
    for (let start = 0; ; start += limit) {
      const query = new URLSearchParams({
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Episode,Series',
        Fields: 'ProviderIds',
        EnableUserData: 'true',
        EnableTotalRecordCount: 'true',
        StartIndex: String(start),
        Limit: String(limit),
      });
      const response = await providerJson<{ Items?: JellyfinItem[]; TotalRecordCount?: number }>(
        'Jellyfin',
        this.endpoint(
          credentials.serverUrl,
          `/Users/${encodeURIComponent(credentials.userId)}/Items?${query.toString()}`,
        ),
        {
          headers: {
            'X-Emby-Authorization': `${CLIENT_AUTH}, Token="${credentials.accessToken}"`,
            'X-Emby-Token': credentials.accessToken,
          },
          redirect: 'error',
        },
      );
      const page = response.Items ?? [];
      all.push(...page);
      if (page.length < limit || all.length >= Number(response.TotalRecordCount ?? 0)) break;
    }
    const collections = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: 'BoxSet',
    });

    const seriesById = new Map(
      all.filter((item) => item.Type === 'Series' && item.Id).map((item) => [item.Id!, item]),
    );
    const items: InboundSyncItem[] = [];
    for (const item of all) {
      const name = item.Name?.trim();
      if (!name || !item.Id) continue;
      const userData = item.UserData ?? {};
      if (item.Type === 'Movie') {
        const ids = cleanExternalIds(item.ProviderIds);
        const base = {
          mediaType: 'MOVIE' as const,
          title: name,
          year: item.ProductionYear ?? null,
          ids,
        };
        if (userData.Played) {
          items.push({
            ...base,
            entityType: 'WATCHED_MOVIE',
            watchedAt: isoOrNull(userData.DatePlayed),
            watchCount: 1,
            sourceKey: `movie:${item.Id}:watched`,
          });
        }
        if (userData.IsFavorite) {
          items.push({
            ...base,
            entityType: 'WATCHLIST_MOVIE',
            sourceKey: `movie:${item.Id}:favorite`,
          });
        }
      } else if (item.Type === 'Series' && userData.IsFavorite) {
        items.push({
          entityType: 'WATCHLIST_SHOW',
          mediaType: 'SHOW',
          title: name,
          year: item.ProductionYear ?? null,
          ids: cleanExternalIds(item.ProviderIds),
          sourceKey: `series:${item.Id}:favorite`,
        });
      } else if (item.Type === 'Episode' && userData.Played) {
        const series = item.SeriesId ? seriesById.get(item.SeriesId) : undefined;
        const season = Number(item.ParentIndexNumber);
        const episode = Number(item.IndexNumber);
        if (
          !Number.isInteger(season) ||
          !Number.isInteger(episode) ||
          season <= 0 ||
          episode <= 0
        ) {
          continue;
        }
        items.push({
          entityType: 'WATCHED_EPISODE',
          mediaType: 'SHOW',
          title: series?.Name ?? item.SeriesName ?? name,
          year: series?.ProductionYear ?? null,
          ids: cleanExternalIds(series?.ProviderIds),
          episodeIds: cleanExternalIds(item.ProviderIds),
          season,
          episode,
          watchedAt: isoOrNull(userData.DatePlayed),
          watchCount: 1,
          sourceKey: item.SeriesId
            ? `series:${item.SeriesId}:episode:${item.Id}:watched`
            : `episode:${item.Id}:watched`,
        });
      }
    }
    for (const collection of collections) {
      const name = collection.Name?.trim();
      if (!name || !collection.Id) continue;
      const listKey = `boxset:${collection.Id}`;
      const collectionItems = await this.fetchItems(credentials, {
        ParentId: collection.Id,
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        Fields: 'ProviderIds',
      });
      items.push({
        entityType: 'LIST',
        mediaType: 'MOVIE',
        title: name,
        ids: {},
        listKey,
        listTitle: name,
        sourceKey: `${listKey}:list`,
      });
      collectionItems.forEach((collectionItem, order) => {
        const itemName = collectionItem.Name?.trim();
        if (
          !itemName ||
          !collectionItem.Id ||
          !['Movie', 'Series'].includes(String(collectionItem.Type))
        ) {
          return;
        }
        items.push({
          entityType: 'LIST_ITEM',
          mediaType: collectionItem.Type === 'Movie' ? 'MOVIE' : 'SHOW',
          title: itemName,
          year: collectionItem.ProductionYear ?? null,
          ids: cleanExternalIds(collectionItem.ProviderIds),
          listKey,
          listOrder: order,
          sourceKey: `${listKey}:item:${collectionItem.Id}`,
        });
      });
    }
    return { items, cursor: null };
  }
}
