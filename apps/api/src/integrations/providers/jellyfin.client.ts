import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cleanExternalIds, isoOrNull, providerJson } from './provider-http';
import {
  assertAllowedMediaServerUrl,
  isPrivateAddress,
  normalizeMediaServerUrl,
} from './media-server-url';
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

export { isPrivateAddress };

export function normalizeJellyfinUrl(raw: string): string {
  return normalizeMediaServerUrl(raw, 'Jellyfin');
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
    await assertAllowedMediaServerUrl(
      serverUrl,
      Boolean(this.config.get<boolean>('integrations.allowPrivateUrls')),
      'Jellyfin',
    );
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
      const total = Number(response.TotalRecordCount);
      if (page.length < limit || (Number.isFinite(total) && total > 0 && all.length >= total))
        break;
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

  async sync(
    credentials: JellyfinCredentials,
    options: { includeCollections?: boolean } = {},
  ): Promise<ProviderSyncPayload> {
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
    const collections =
      options.includeCollections === false
        ? []
        : await this.fetchItems(credentials, {
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
    return {
      items,
      cursor: null,
      snapshotEntityTypes: [
        'WATCHED_EPISODE',
        'WATCHED_MOVIE',
        'WATCHLIST_SHOW',
        'WATCHLIST_MOVIE',
        'LIST',
        'LIST_ITEM',
      ],
    };
  }
}
