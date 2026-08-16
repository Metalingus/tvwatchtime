import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type { PlexServerDto } from '@tvwatch/shared';
import { assertAllowedMediaServerUrl, normalizeMediaServerUrl } from './media-server-url';
import { isoOrNull, providerJson } from './provider-http';
import type {
  InboundExternalIds,
  InboundSyncItem,
  ProviderSnapshotScope,
  ProviderSyncPayload,
} from './types';

const PLEX_TV = 'https://plex.tv';
const PLEX_DISCOVER = 'https://discover.provider.plex.tv';
const PLEX_METADATA = 'https://metadata.provider.plex.tv';
const PLEX_WATCH_LINK_CACHE_LIMIT = 1_000;
const PLEX_WATCH_LINK_CACHE_MS = 24 * 60 * 60_000;
const PLEX_WATCH_LINK_MISS_CACHE_MS = 15 * 60_000;

type PlexConnection = {
  uri?: string;
  protocol?: string;
  local?: boolean | number | string;
  relay?: boolean | number | string;
};

type PlexResource = {
  name?: string;
  clientIdentifier?: string;
  provides?: string;
  owned?: boolean | number | string;
  accessToken?: string;
  connections?: PlexConnection[];
  Connection?: PlexConnection[];
};

type PlexMetadata = {
  ratingKey?: string | number;
  key?: string;
  guid?: string;
  type?: 'movie' | 'show' | 'episode' | 'collection' | string;
  subtype?: string;
  title?: string;
  year?: number;
  index?: number;
  parentIndex?: number;
  grandparentTitle?: string;
  grandparentRatingKey?: string | number;
  slug?: string;
  viewCount?: number;
  viewedLeafCount?: number;
  lastViewedAt?: number | string;
  playlistType?: string;
  Guid?: Array<{ id?: string } | string>;
};

type PlexMediaContainer = {
  size?: number;
  totalSize?: number;
  offset?: number;
  Metadata?: PlexMetadata[];
  Directory?: PlexMetadata[];
  Hub?: Array<{ Metadata?: PlexMetadata[] }>;
};

export type PlexCredentials = {
  accountToken: string;
  clientIdentifier: string;
  accountId?: string;
  machineIdentifier?: string;
};

export type ResolvedPlexServer = PlexServerDto & {
  serverUrl: string;
  accessToken: string;
};

export type PlexMediaLookup = {
  mediaType: 'MOVIE' | 'SHOW';
  ids?: InboundExternalIds;
};

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function plexExternalIds(item: PlexMetadata | undefined): InboundExternalIds {
  const values = [
    item?.guid,
    ...(item?.Guid ?? []).map((value) => (typeof value === 'string' ? value : value.id)),
  ].filter((value): value is string => Boolean(value));
  const ids: InboundExternalIds = {};
  for (const value of values) {
    const imdb = value.match(/(?:^|\.)imdb:\/\/(tt\d+)/i);
    const tmdb = value.match(/(?:tmdb|themoviedb):\/\/(\d+)/i);
    const tvdb = value.match(/(?:tvdb|thetvdb):\/\/(\d+)/i);
    if (imdb) ids.imdb = imdb[1];
    if (tmdb) ids.tmdb = Number(tmdb[1]);
    if (tvdb) ids.tvdb = Number(tvdb[1]);
  }
  return ids;
}

function plexTimestamp(value: unknown): string | null {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : isoOrNull(value);
}

function metadataId(item: PlexMetadata): string | null {
  if (item.ratingKey !== undefined && item.ratingKey !== null) return String(item.ratingKey);
  const match = item.key?.match(/\/(?:metadata|collections)\/([^/?]+)/);
  return match?.[1] ?? null;
}

export function plexWatchUrl(mediaType: 'MOVIE' | 'SHOW', slug: string): string {
  return `https://watch.plex.tv/${mediaType === 'MOVIE' ? 'movie' : 'show'}/${encodeURIComponent(slug)}`;
}

@Injectable()
export class PlexClient {
  private readonly watchUrlCache = new Map<string, { url: string | null; expiresAt: number }>();

  constructor(private readonly config: ConfigService) {}

  private product(): string {
    return this.config.get<string>('integrations.appName') || 'TVWatch';
  }

  private version(): string {
    return this.config.get<string>('integrations.appVersion') || '0.1.0';
  }

  private headers(
    clientIdentifier: string,
    token?: string,
    extra: Record<string, string> = {},
  ): Record<string, string> {
    return {
      Accept: 'application/json',
      'X-Plex-Product': this.product(),
      'X-Plex-Version': this.version(),
      'X-Plex-Client-Identifier': clientIdentifier,
      ...(token ? { 'X-Plex-Token': token } : {}),
      ...extra,
    };
  }

  async startLink() {
    const clientIdentifier = randomUUID();
    const url = new URL('/api/v2/pins', PLEX_TV);
    url.searchParams.set('strong', 'true');
    const response = await providerJson<any>('Plex', url.toString(), {
      method: 'POST',
      headers: this.headers(clientIdentifier),
    });
    if (!response.id || !response.code) {
      throw new BadRequestException('Plex did not create an authorization code');
    }
    const params = new URLSearchParams({
      clientID: clientIdentifier,
      code: String(response.code),
      'context[device][product]': this.product(),
    });
    const expiresAt = response.expiresAt
      ? new Date(response.expiresAt)
      : new Date(Date.now() + Math.max(60, Number(response.expiresIn) || 900) * 1000);
    return {
      id: String(response.id),
      code: String(response.code),
      clientIdentifier,
      verificationUrl: `https://app.plex.tv/auth#?${params.toString()}`,
      expiresAt,
      pollAfterSeconds: 2,
    };
  }

  async completeLink(input: { id: string; code: string; clientIdentifier: string }) {
    const url = new URL(`/api/v2/pins/${encodeURIComponent(input.id)}`, PLEX_TV);
    url.searchParams.set('code', input.code);
    const pin = await providerJson<any>('Plex', url.toString(), {
      headers: this.headers(input.clientIdentifier),
    });
    const accountToken = pin.authToken;
    if (!accountToken) return null;
    const account = await providerJson<any>('Plex', `${PLEX_TV}/api/v2/user`, {
      headers: this.headers(input.clientIdentifier, accountToken),
    });
    const credentials: PlexCredentials = {
      accountToken: String(accountToken),
      clientIdentifier: input.clientIdentifier,
      accountId: account.id ? String(account.id) : undefined,
    };
    return {
      credentials,
      displayName: String(account.username ?? account.title ?? account.email ?? 'Plex'),
      servers: await this.listServers(credentials),
    };
  }

  private async resources(credentials: PlexCredentials): Promise<PlexResource[]> {
    const url = new URL('/api/v2/resources', PLEX_TV);
    url.searchParams.set('includeHttps', '1');
    url.searchParams.set('includeRelay', '1');
    url.searchParams.set('includeIPv6', '0');
    const response = await providerJson<any>('Plex', url.toString(), {
      headers: this.headers(credentials.clientIdentifier, credentials.accountToken),
    });
    return Array.isArray(response) ? response : (response?.MediaContainer?.Device ?? []);
  }

  async listServers(credentials: PlexCredentials): Promise<PlexServerDto[]> {
    const resources = await this.resources(credentials);
    return resources
      .filter(
        (resource) =>
          resource.clientIdentifier &&
          String(resource.provides ?? '')
            .split(',')
            .map((value) => value.trim())
            .includes('server'),
      )
      .map((resource) => ({
        machineIdentifier: String(resource.clientIdentifier),
        name: String(resource.name ?? 'Plex Media Server'),
        owned: bool(resource.owned),
      }));
  }

  async resolveServer(credentials: PlexCredentials): Promise<ResolvedPlexServer> {
    if (!credentials.machineIdentifier) {
      throw new BadRequestException('Select a Plex Media Server first');
    }
    const resource = (await this.resources(credentials)).find(
      (item) => item.clientIdentifier === credentials.machineIdentifier,
    );
    if (!resource) throw new BadRequestException('The selected Plex server is no longer available');
    const connections = [...(resource.connections ?? resource.Connection ?? [])].sort((a, b) => {
      const rank = (value: PlexConnection) =>
        (value.protocol === 'https' ? 0 : 4) +
        (bool(value.local) ? 2 : 0) +
        (bool(value.relay) ? 1 : 0);
      return rank(a) - rank(b);
    });
    for (const connection of connections) {
      if (!connection.uri) continue;
      try {
        const serverUrl = normalizeMediaServerUrl(connection.uri, 'Plex');
        await assertAllowedMediaServerUrl(
          serverUrl,
          Boolean(this.config.get<boolean>('integrations.allowPrivateUrls')),
          'Plex',
        );
        return {
          machineIdentifier: credentials.machineIdentifier,
          name: String(resource.name ?? 'Plex Media Server'),
          owned: bool(resource.owned),
          serverUrl,
          accessToken: String(resource.accessToken ?? credentials.accountToken),
        };
      } catch {
        // Try the next advertised public, relay, or explicitly allowed private connection.
      }
    }
    throw new BadRequestException('No reachable Plex server connection is allowed');
  }

  private async fetchPages(
    baseUrl: string,
    path: string,
    clientIdentifier: string,
    accessToken: string,
    parameters: Record<string, string> = {},
  ): Promise<PlexMetadata[]> {
    const all: PlexMetadata[] = [];
    const limit = 500;
    let start = 0;
    for (;;) {
      const url = new URL(path, `${baseUrl}/`);
      for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
      const response = await providerJson<{ MediaContainer?: PlexMediaContainer }>(
        'Plex',
        url.toString(),
        {
          headers: this.headers(clientIdentifier, accessToken, {
            'X-Plex-Container-Start': String(start),
            'X-Plex-Container-Size': String(limit),
          }),
          redirect: 'error',
        },
      );
      const container = response.MediaContainer ?? {};
      const page = container.Metadata ?? container.Directory ?? [];
      const offset = Number(container.offset);
      if (start > 0 && Number.isFinite(offset) && offset < start) break;
      all.push(...page);
      const total = Number(container.totalSize ?? 0);
      if (!page.length || (total > 0 && all.length >= total)) break;
      const next = Number.isFinite(offset) ? offset + page.length : start + page.length;
      if (next <= start || (total <= 0 && page.length < limit)) break;
      start = next;
    }
    return all;
  }

  private async serverItems(
    server: ResolvedPlexServer,
    credentials: PlexCredentials,
    path: string,
    parameters: Record<string, string> = {},
  ): Promise<PlexMetadata[]> {
    return this.fetchPages(
      server.serverUrl,
      path,
      credentials.clientIdentifier,
      server.accessToken,
      parameters,
    );
  }

  private async accountItems(
    credentials: PlexCredentials,
    path: string,
    parameters: Record<string, string> = {},
  ): Promise<PlexMetadata[]> {
    const url = new URL(path, `${PLEX_DISCOVER}/`);
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
    const response = await providerJson<{ MediaContainer?: PlexMediaContainer }>(
      'Plex',
      url.toString(),
      {
        headers: this.headers(credentials.clientIdentifier, credentials.accountToken),
        redirect: 'error',
      },
    );
    const container = response.MediaContainer ?? {};
    return container.Metadata ?? container.Directory ?? [];
  }

  private async accountWatchedEpisodes(
    credentials: PlexCredentials,
    watchlistShows: PlexMetadata[],
  ): Promise<{ items: InboundSyncItem[]; snapshotScopes: ProviderSnapshotScope[] }> {
    const items: InboundSyncItem[] = [];
    const snapshotScopes: ProviderSnapshotScope[] = [];
    const showKeys = watchlistShows
      .map((show) => metadataId(show))
      .filter((value): value is string => Boolean(value));
    const detailsByKey = new Map<string, PlexMetadata>();

    for (let start = 0; start < showKeys.length; start += 50) {
      const keys = showKeys.slice(start, start + 50);
      const details = await this.accountItems(
        credentials,
        `/library/metadata/${keys.map(encodeURIComponent).join(',')}`,
        { includeGuids: '1', includeUserState: '1' },
      );
      for (const detail of details) {
        const key = metadataId(detail);
        if (key) detailsByKey.set(key, detail);
      }
    }

    for (const watchlistShow of watchlistShows) {
      const showKey = metadataId(watchlistShow);
      const show = showKey ? detailsByKey.get(showKey) : undefined;
      if (!showKey || !show) continue;
      const sourceKeyPrefix = `plex:account:show:${showKey}:episode:`;
      const showTitle = show.title?.trim() || watchlistShow.title?.trim();
      if (!showTitle) continue;
      try {
        if (Number(show.viewedLeafCount ?? 0) > 0) {
          const seasons = await this.accountItems(
            credentials,
            `/library/metadata/${encodeURIComponent(showKey)}/children`,
            { includeGuids: '1', includeUserState: '1' },
          );
          for (const seasonItem of seasons) {
            const season = Number(seasonItem.index);
            const seasonKey = metadataId(seasonItem);
            if (!seasonKey || !Number.isInteger(season) || season <= 0) continue;
            if (
              seasonItem.viewedLeafCount !== undefined &&
              Number(seasonItem.viewedLeafCount ?? 0) <= 0
            ) {
              continue;
            }
            const episodes = await this.accountItems(
              credentials,
              `/library/metadata/${encodeURIComponent(seasonKey)}/children`,
              { includeGuids: '1', includeUserState: '1' },
            );
            for (const episodeItem of episodes) {
              const episodeKey = metadataId(episodeItem);
              const episode = Number(episodeItem.index);
              if (
                !episodeKey ||
                !Number.isInteger(episode) ||
                episode <= 0 ||
                Number(episodeItem.viewCount ?? 0) <= 0
              ) {
                continue;
              }
              items.push({
                entityType: 'WATCHED_EPISODE',
                mediaType: 'SHOW',
                title: showTitle,
                year: show.year ?? watchlistShow.year ?? null,
                ids: plexExternalIds(show),
                episodeIds: plexExternalIds(episodeItem),
                season,
                episode,
                watchedAt: plexTimestamp(episodeItem.lastViewedAt),
                watchCount: Math.max(1, Number(episodeItem.viewCount) || 1),
                sourceKey: `${sourceKeyPrefix}${episodeKey}:watched`,
              });
            }
          }
        }
        snapshotScopes.push({ entityType: 'WATCHED_EPISODE', sourceKeyPrefix });
      } catch {
        // Preserve this show's last complete account snapshot when any season request fails.
      }
    }
    return { items, snapshotScopes };
  }

  async syncAccount(credentials: PlexCredentials): Promise<ProviderSyncPayload> {
    const items: InboundSyncItem[] = [];
    const snapshotScopes: ProviderSnapshotScope[] = [
      { entityType: 'WATCHLIST_SHOW', sourceKeyPrefix: 'plex:watchlist:' },
      { entityType: 'WATCHLIST_MOVIE', sourceKeyPrefix: 'plex:watchlist:' },
    ];
    const watchlist = await this.accountItems(credentials, '/library/sections/watchlist/all', {
      includeCollections: '1',
      includeExternalMedia: '1',
      includeGuids: '1',
      includeOptionalElements: 'Guid',
    });
    for (const item of watchlist) {
      const title = item.title?.trim();
      const id = item.guid ?? item.key ?? metadataId(item);
      if (!title || !id || !['movie', 'show'].includes(String(item.type))) continue;
      items.push({
        entityType: item.type === 'movie' ? 'WATCHLIST_MOVIE' : 'WATCHLIST_SHOW',
        mediaType: item.type === 'movie' ? 'MOVIE' : 'SHOW',
        title,
        year: item.year ?? null,
        ids: plexExternalIds(item),
        sourceKey: `plex:watchlist:${item.type}:${encodeURIComponent(String(id))}`,
      });
    }
    const accountEpisodes = await this.accountWatchedEpisodes(
      credentials,
      watchlist.filter((item) => item.type === 'show'),
    );
    items.push(...accountEpisodes.items);
    snapshotScopes.push(...accountEpisodes.snapshotScopes);
    return { items, cursor: null, snapshotScopes };
  }

  async findWatchUrl(
    credentials: PlexCredentials,
    target: PlexMediaLookup,
  ): Promise<string | null> {
    const guids = [
      target.ids?.imdb ? `imdb://${target.ids.imdb}` : null,
      target.ids?.tmdb ? `tmdb://${target.ids.tmdb}` : null,
    ].filter((guid): guid is string => Boolean(guid));
    const type = target.mediaType === 'MOVIE' ? '1' : '2';

    for (const guid of guids) {
      const cacheKey = `${type}:${guid.toLowerCase()}`;
      const cached = this.watchUrlCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        if (cached.url) return cached.url;
        continue;
      }
      if (cached) this.watchUrlCache.delete(cacheKey);

      const url = new URL('/library/metadata/matches', PLEX_METADATA);
      url.searchParams.set('guid', guid);
      url.searchParams.set('type', type);
      try {
        const response = await providerJson<{ MediaContainer?: PlexMediaContainer }>(
          'Plex',
          url.toString(),
          {
            headers: this.headers(credentials.clientIdentifier, credentials.accountToken),
            redirect: 'error',
          },
        );
        const slug = response.MediaContainer?.Metadata?.[0]?.slug?.trim();
        const watchUrl = slug ? plexWatchUrl(target.mediaType, slug) : null;
        this.rememberWatchUrl(cacheKey, watchUrl);
        if (watchUrl) return watchUrl;
      } catch {
        // A second trusted ID may still resolve the public Plex item.
      }
    }
    return null;
  }

  private rememberWatchUrl(cacheKey: string, url: string | null): void {
    if (this.watchUrlCache.size >= PLEX_WATCH_LINK_CACHE_LIMIT) {
      const oldestKey = this.watchUrlCache.keys().next().value;
      if (oldestKey) this.watchUrlCache.delete(oldestKey);
    }
    this.watchUrlCache.set(cacheKey, {
      url,
      expiresAt: Date.now() + (url ? PLEX_WATCH_LINK_CACHE_MS : PLEX_WATCH_LINK_MISS_CACHE_MS),
    });
  }

  async sync(
    credentials: PlexCredentials,
    options: { includeCollections?: boolean } = {},
  ): Promise<ProviderSyncPayload> {
    const server = await this.resolveServer(credentials);
    const sections = await this.serverItems(server, credentials, '/library/sections');
    const items: InboundSyncItem[] = [];
    const snapshotScopes: ProviderSnapshotScope[] = [
      {
        entityType: 'WATCHED_MOVIE',
        sourceKeyPrefix: `plex:${server.machineIdentifier}:movie:`,
      },
      {
        entityType: 'WATCHED_EPISODE',
        sourceKeyPrefix: `plex:${server.machineIdentifier}:show:`,
      },
      { entityType: 'LIST', sourceKeyPrefix: `plex:${server.machineIdentifier}:collection:` },
      { entityType: 'LIST_ITEM', sourceKeyPrefix: `plex:${server.machineIdentifier}:collection:` },
      { entityType: 'LIST', sourceKeyPrefix: `plex:${server.machineIdentifier}:playlist:` },
      { entityType: 'LIST_ITEM', sourceKeyPrefix: `plex:${server.machineIdentifier}:playlist:` },
    ];
    const showCache = new Map<string, PlexMetadata | null>();

    const showFor = async (ratingKey: string): Promise<PlexMetadata | null> => {
      if (showCache.has(ratingKey)) return showCache.get(ratingKey) ?? null;
      const result = await this.serverItems(
        server,
        credentials,
        `/library/metadata/${encodeURIComponent(ratingKey)}`,
        { includeGuids: '1', includeOptionalElements: 'Guid' },
      );
      const show = result[0] ?? null;
      showCache.set(ratingKey, show);
      return show;
    };

    for (const section of sections) {
      const sectionId = section.key ?? metadataId(section);
      if (!sectionId || !['movie', 'show'].includes(String(section.type))) continue;
      const type = section.type === 'movie' ? '1' : '4';
      const watched = await this.serverItems(
        server,
        credentials,
        `/library/sections/${encodeURIComponent(sectionId)}/all`,
        { type, 'viewCount>>': '0', includeGuids: '1', includeOptionalElements: 'Guid' },
      );
      for (const item of watched) {
        const ratingKey = metadataId(item);
        const title = item.title?.trim();
        if (!ratingKey || !title || Number(item.viewCount ?? 0) <= 0) continue;
        if (item.type === 'movie') {
          items.push({
            entityType: 'WATCHED_MOVIE',
            mediaType: 'MOVIE',
            title,
            year: item.year ?? null,
            ids: plexExternalIds(item),
            watchedAt: plexTimestamp(item.lastViewedAt),
            watchCount: Math.max(1, Number(item.viewCount) || 1),
            sourceKey: `plex:${server.machineIdentifier}:movie:${ratingKey}:watched`,
          });
        } else if (item.type === 'episode') {
          const showKey = item.grandparentRatingKey ? String(item.grandparentRatingKey) : '';
          const show = showKey ? await showFor(showKey) : null;
          const season = Number(item.parentIndex);
          const episode = Number(item.index);
          if (
            !showKey ||
            !Number.isInteger(season) ||
            !Number.isInteger(episode) ||
            season <= 0 ||
            episode <= 0
          )
            continue;
          items.push({
            entityType: 'WATCHED_EPISODE',
            mediaType: 'SHOW',
            title: show?.title ?? item.grandparentTitle ?? title,
            year: show?.year ?? null,
            ids: plexExternalIds(show ?? undefined),
            episodeIds: plexExternalIds(item),
            season,
            episode,
            watchedAt: plexTimestamp(item.lastViewedAt),
            watchCount: Math.max(1, Number(item.viewCount) || 1),
            sourceKey: `plex:${server.machineIdentifier}:show:${showKey}:episode:${ratingKey}:watched`,
          });
        }
      }

      const collections =
        options.includeCollections === false
          ? []
          : await this.serverItems(
              server,
              credentials,
              `/library/sections/${encodeURIComponent(sectionId)}/collections`,
              { includeGuids: '1', includeOptionalElements: 'Guid' },
            );
      for (const collection of collections) {
        const collectionId = metadataId(collection);
        const title = collection.title?.trim();
        if (!collectionId || !title) continue;
        const listKey = `plex:${server.machineIdentifier}:collection:${collectionId}`;
        const children = await this.serverItems(
          server,
          credentials,
          collection.key
            ? `${collection.key.replace(/\/$/, '')}/children`
            : `/library/collections/${encodeURIComponent(collectionId)}/children`,
          { includeGuids: '1', includeOptionalElements: 'Guid' },
        );
        items.push({
          entityType: 'LIST',
          mediaType: section.type === 'movie' ? 'MOVIE' : 'SHOW',
          title,
          ids: {},
          listKey,
          listTitle: title,
          sourceKey: `${listKey}:list`,
        });
        children.forEach((child, order) => {
          const childId = metadataId(child);
          const childTitle = child.title?.trim();
          if (!childId || !childTitle || !['movie', 'show'].includes(String(child.type))) return;
          items.push({
            entityType: 'LIST_ITEM',
            mediaType: child.type === 'movie' ? 'MOVIE' : 'SHOW',
            title: childTitle,
            year: child.year ?? null,
            ids: plexExternalIds(child),
            listKey,
            listOrder: order,
            sourceKey: `${listKey}:item:${childId}`,
          });
        });
      }
    }

    if (options.includeCollections !== false) {
      const playlists = await this.serverItems(server, credentials, '/playlists', {
        playlistType: 'video',
      });
      for (const playlist of playlists) {
        const playlistId = metadataId(playlist);
        const title = playlist.title?.trim();
        if (!playlistId || !title || (playlist.playlistType && playlist.playlistType !== 'video')) {
          continue;
        }
        const listKey = `plex:${server.machineIdentifier}:playlist:${playlistId}`;
        const children = await this.serverItems(
          server,
          credentials,
          `/playlists/${encodeURIComponent(playlistId)}/items`,
          { includeGuids: '1', includeOptionalElements: 'Guid' },
        );
        const supportedChildren = children.filter((child) =>
          ['movie', 'show'].includes(String(child.type)),
        );
        items.push({
          entityType: 'LIST',
          mediaType:
            supportedChildren.length > 0 && supportedChildren.every((item) => item.type === 'show')
              ? 'SHOW'
              : 'MOVIE',
          title,
          ids: {},
          listKey,
          listTitle: title,
          sourceKey: `${listKey}:list`,
        });
        supportedChildren.forEach((child, order) => {
          const childId = metadataId(child);
          const childTitle = child.title?.trim();
          if (!childId || !childTitle) return;
          items.push({
            entityType: 'LIST_ITEM',
            mediaType: child.type === 'movie' ? 'MOVIE' : 'SHOW',
            title: childTitle,
            year: child.year ?? null,
            ids: plexExternalIds(child),
            listKey,
            listOrder: order,
            sourceKey: `${listKey}:item:${childId}`,
          });
        });
      }
    }

    const account = await this.syncAccount(credentials);
    items.push(...account.items);
    snapshotScopes.push(...(account.snapshotScopes ?? []));

    return { items, cursor: null, snapshotScopes };
  }
}
