import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { cleanExternalIds, isoOrNull, providerJson, providerOk } from './provider-http';
import { assertAllowedMediaServerUrl, normalizeMediaServerUrl } from './media-server-url';
import type { InboundSyncItem, ProviderSyncPayload } from './types';

type EmbyItem = {
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
    LastPlayedDate?: string | null;
    DatePlayed?: string | null;
    PlayCount?: number | null;
  };
};

export type EmbyCredentials = {
  serverUrl: string;
  accessToken: string;
  userId: string;
  serverId: string;
};

type EmbyMediaLookup = {
  mediaType: 'MOVIE' | 'SHOW';
  title: string;
  year?: number | null;
  ids?: { imdb?: string; tmdb?: number; tvdb?: number };
};

export function normalizeEmbyUrl(raw: string): string {
  return normalizeMediaServerUrl(raw, 'Emby');
}

function embyApiBase(serverUrl: string): string {
  const normalized = normalizeEmbyUrl(serverUrl);
  return /\/emby$/i.test(new URL(normalized).pathname) ? normalized : `${normalized}/emby`;
}

export function embyItemIdFromSourceKey(sourceKey: string): string | null {
  const patterns = [
    /^emby:movie:([^:]+):/,
    /^emby:series:([^:]+):(?:favorite|watchlist)$/,
    /^emby:series:([^:]+):episode:/,
    /^emby:boxset:[^:]+:item:([^:]+)$/,
  ];
  for (const pattern of patterns) {
    const match = sourceKey.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function embyWebUrl(serverUrl: string, serverId: string, itemId?: string | null): string {
  const url = new URL(normalizeEmbyUrl(serverUrl));
  url.pathname = url.pathname.replace(/\/emby$/i, '').replace(/\/$/, '');
  const base = url.toString().replace(/\/$/, '');
  return itemId
    ? `${base}/web/index.html#!/item?id=${encodeURIComponent(itemId)}&serverId=${encodeURIComponent(
        serverId,
      )}`
    : base;
}

export function embyIosItemUrl(serverId: string, itemId: string): string {
  return `emby://items?serverId=${encodeURIComponent(serverId)}&itemId=${encodeURIComponent(
    itemId,
  )}`;
}

export function embyAndroidItemUrl(serverId: string, itemId: string): string {
  return `emby://items/${encodeURIComponent(serverId)}/${encodeURIComponent(itemId)}`;
}

@Injectable()
export class EmbyClient {
  constructor(private readonly config: ConfigService) {}

  private clientAuth(accessToken?: string, userId?: string): string {
    const appName = this.config.get<string>('integrations.appName') || 'TVWatch';
    const appVersion = this.config.get<string>('integrations.appVersion') || '0.1.0';
    const user = userId ? ` UserId="${userId}",` : '';
    const token = accessToken ? `, Token="${accessToken}"` : '';
    return `Emby${user} Client="${appName}", Device="Server", DeviceId="tvwatch-integration", Version="${appVersion}"${token}`;
  }

  private async assertAllowed(serverUrl: string) {
    await assertAllowedMediaServerUrl(
      serverUrl,
      Boolean(this.config.get<boolean>('integrations.allowPrivateUrls')),
      'Emby',
    );
  }

  private endpoint(serverUrl: string, path: string): string {
    return `${embyApiBase(serverUrl)}${path}`;
  }

  private headers(accessToken: string, userId?: string): Record<string, string> {
    return {
      'X-Emby-Authorization': this.clientAuth(accessToken, userId),
      'X-Emby-Token': accessToken,
    };
  }

  private async fetchItems(
    credentials: EmbyCredentials,
    parameters: Record<string, string>,
  ): Promise<EmbyItem[]> {
    const all: EmbyItem[] = [];
    const limit = 500;
    for (let start = 0; ; start += limit) {
      const query = new URLSearchParams({
        ...parameters,
        EnableTotalRecordCount: 'true',
        StartIndex: String(start),
        Limit: String(limit),
      });
      const response = await providerJson<{ Items?: EmbyItem[]; TotalRecordCount?: number }>(
        'Emby',
        this.endpoint(
          credentials.serverUrl,
          `/Users/${encodeURIComponent(credentials.userId)}/Items?${query.toString()}`,
        ),
        { headers: this.headers(credentials.accessToken, credentials.userId), redirect: 'error' },
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
    const serverUrl = normalizeEmbyUrl(serverUrlInput);
    await this.assertAllowed(serverUrl);
    const response = await providerJson<any>(
      'Emby',
      this.endpoint(serverUrl, '/Users/AuthenticateByName'),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Emby-Authorization': this.clientAuth(),
        },
        body: JSON.stringify({ Username: username, Pw: password }),
        redirect: 'error',
      },
    );
    const accessToken = response.AccessToken;
    const userId = response.User?.Id;
    const serverId = response.ServerId;
    if (!accessToken || !userId || !serverId) {
      throw new BadRequestException('Emby login failed');
    }
    return {
      serverUrl,
      accessToken: String(accessToken),
      userId: String(userId),
      serverId: String(serverId),
      displayName: String(response.User?.Name ?? username),
    };
  }

  async logout(credentials: EmbyCredentials): Promise<void> {
    await this.assertAllowed(credentials.serverUrl);
    await providerOk('Emby', this.endpoint(credentials.serverUrl, '/Sessions/Logout'), {
      method: 'POST',
      headers: this.headers(credentials.accessToken, credentials.userId),
      redirect: 'error',
    });
  }

  async findLibraryItemId(
    credentials: EmbyCredentials,
    target: EmbyMediaLookup,
  ): Promise<string | null> {
    await this.assertAllowed(credentials.serverUrl);
    const candidates = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: target.mediaType === 'MOVIE' ? 'Movie' : 'Series',
      Fields: 'ProviderIds',
      SearchTerm: target.title,
      EnableUserData: 'false',
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
    return (
      candidates.find(
        (candidate) =>
          candidate.Id &&
          candidate.Name?.trim().toLocaleLowerCase() === title &&
          (!target.year || !candidate.ProductionYear || candidate.ProductionYear === target.year),
      )?.Id ?? null
    );
  }

  async sync(
    credentials: EmbyCredentials,
    options: { includeCollections?: boolean } = {},
  ): Promise<ProviderSyncPayload> {
    await this.assertAllowed(credentials.serverUrl);
    // Keep these requests sequential: large self-hosted libraries should not be scanned in parallel.
    const played = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Episode',
      IsPlayed: 'true',
      Fields: 'ProviderIds',
      EnableUserData: 'true',
    });
    const favorites = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: 'Movie,Series',
      IsFavorite: 'true',
      Fields: 'ProviderIds',
      EnableUserData: 'true',
    });
    const series = await this.fetchItems(credentials, {
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      Fields: 'ProviderIds',
      EnableUserData: 'false',
    });
    const collections =
      options.includeCollections === false
        ? []
        : await this.fetchItems(credentials, {
            Recursive: 'true',
            IncludeItemTypes: 'BoxSet',
            EnableUserData: 'false',
          });

    const seriesById = new Map(series.filter((item) => item.Id).map((item) => [item.Id!, item]));
    const items: InboundSyncItem[] = [];
    for (const item of played) {
      const name = item.Name?.trim();
      if (!name || !item.Id || !item.UserData?.Played) continue;
      const watchedAt = isoOrNull(item.UserData.LastPlayedDate ?? item.UserData.DatePlayed);
      const watchCount = Math.max(1, Number(item.UserData.PlayCount) || 1);
      if (item.Type === 'Movie') {
        items.push({
          entityType: 'WATCHED_MOVIE',
          mediaType: 'MOVIE',
          title: name,
          year: item.ProductionYear ?? null,
          ids: cleanExternalIds(item.ProviderIds),
          watchedAt,
          watchCount,
          sourceKey: `emby:movie:${item.Id}:watched`,
        });
      } else if (item.Type === 'Episode') {
        const parent = item.SeriesId ? seriesById.get(item.SeriesId) : undefined;
        const season = Number(item.ParentIndexNumber);
        const episode = Number(item.IndexNumber);
        if (!Number.isInteger(season) || !Number.isInteger(episode) || season <= 0 || episode <= 0)
          continue;
        items.push({
          entityType: 'WATCHED_EPISODE',
          mediaType: 'SHOW',
          title: parent?.Name ?? item.SeriesName ?? name,
          year: parent?.ProductionYear ?? null,
          ids: cleanExternalIds(parent?.ProviderIds),
          episodeIds: cleanExternalIds(item.ProviderIds),
          season,
          episode,
          watchedAt,
          watchCount,
          sourceKey: item.SeriesId
            ? `emby:series:${item.SeriesId}:episode:${item.Id}:watched`
            : `emby:episode:${item.Id}:watched`,
        });
      }
    }

    for (const item of favorites) {
      const name = item.Name?.trim();
      if (!name || !item.Id || !item.UserData?.IsFavorite) continue;
      if (item.Type === 'Movie') {
        items.push({
          entityType: 'WATCHLIST_MOVIE',
          mediaType: 'MOVIE',
          title: name,
          year: item.ProductionYear ?? null,
          ids: cleanExternalIds(item.ProviderIds),
          sourceKey: `emby:movie:${item.Id}:favorite`,
        });
      } else if (item.Type === 'Series') {
        items.push({
          entityType: 'WATCHLIST_SHOW',
          mediaType: 'SHOW',
          title: name,
          year: item.ProductionYear ?? null,
          ids: cleanExternalIds(item.ProviderIds),
          sourceKey: `emby:series:${item.Id}:favorite`,
        });
      }
    }

    for (const collection of collections) {
      const name = collection.Name?.trim();
      if (!name || !collection.Id) continue;
      const listKey = `emby:boxset:${collection.Id}`;
      const children = await this.fetchItems(credentials, {
        ParentId: collection.Id,
        Recursive: 'true',
        IncludeItemTypes: 'Movie,Series',
        Fields: 'ProviderIds',
        EnableUserData: 'false',
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
      children.forEach((child, order) => {
        const childName = child.Name?.trim();
        if (!childName || !child.Id || !['Movie', 'Series'].includes(String(child.Type))) return;
        items.push({
          entityType: 'LIST_ITEM',
          mediaType: child.Type === 'Movie' ? 'MOVIE' : 'SHOW',
          title: childName,
          year: child.ProductionYear ?? null,
          ids: cleanExternalIds(child.ProviderIds),
          listKey,
          listOrder: order,
          sourceKey: `${listKey}:item:${child.Id}`,
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
