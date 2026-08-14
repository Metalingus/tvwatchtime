import { BadRequestException, Injectable } from '@nestjs/common';
import { inflateSync } from 'zlib';
import { providerJson } from './provider-http';
import type { InboundSyncItem, ProviderSyncPayload } from './types';

const LINK_API_URL = 'https://link.stremio.com/api';
const API_URL = 'https://api.strem.io/api';
const CINEMETA_URL = 'https://v3-cinemeta.strem.io/meta';

type StremioLibraryItem = {
  _id?: string;
  id?: string;
  name?: string;
  type?: string;
  removed?: boolean;
  temp?: boolean;
  state?: {
    timesWatched?: number;
    times_watched?: number;
    flaggedWatched?: boolean;
    flagged_watched?: boolean;
    video_id?: string | null;
    videoId?: string | null;
    watched?: string | null;
    lastWatched?: string | null;
    last_watched?: string | null;
  };
};

function imdbFrom(value: unknown): string | undefined {
  const match = String(value ?? '').match(/tt\d+/i);
  return match?.[0];
}

function episodeCoordinates(videoId: string): { season: number; episode: number } | null {
  const match = videoId.match(/:(\d+):(\d+)$/);
  if (!match) return null;
  return { season: Number(match[1]), episode: Number(match[2]) };
}

/** Decode Stremio's official zlib/base64 watched bitfield against Cinemeta video order. */
export function decodeStremioWatched(serialized: string, videoIds: string[]): string[] {
  try {
    const parts = serialized.split(':');
    if (parts.length < 3) return [];
    const encoded = parts.pop()!;
    const anchorLength = Number(parts.pop());
    const anchor = parts.join(':');
    const anchorIndex = videoIds.indexOf(anchor);
    if (!Number.isInteger(anchorLength) || anchorIndex < 0) return [];
    const bytes = inflateSync(Buffer.from(encoded, 'base64'));
    const offset = anchorLength - anchorIndex - 1;
    return videoIds.filter((_, currentIndex) => {
      const previousIndex = currentIndex + offset;
      if (previousIndex < 0) return false;
      const byte = bytes[Math.floor(previousIndex / 8)] ?? 0;
      return ((byte >> (previousIndex % 8)) & 1) === 1;
    });
  } catch {
    return [];
  }
}

@Injectable()
export class StremioClient {
  async startLink() {
    const response = await providerJson<{
      result?: { code?: string; link?: string; qrcode?: string };
      code?: string;
      link?: string;
    }>('Stremio', `${LINK_API_URL}/create?type=Create`);
    const data = response.result ?? response;
    if (!data.code || !data.link) {
      throw new BadRequestException('Stremio did not create a connection code');
    }
    return {
      code: data.code,
      verificationUrl: data.link,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      pollAfterSeconds: 5,
    };
  }

  async completeLink(code: string): Promise<string> {
    const response = await providerJson<any>(
      'Stremio',
      `${LINK_API_URL}/read?type=Read&code=${encodeURIComponent(code)}`,
    );
    const data = response.result ?? response;
    const authKey = data.authKey ?? data.auth_key;
    if (!authKey) throw new BadRequestException('Stremio authorization is still pending');
    return String(authKey);
  }

  private async videos(imdb: string): Promise<string[]> {
    try {
      const response = await providerJson<{ meta?: { videos?: Array<{ id?: string }> } }>(
        'Stremio Cinemeta',
        `${CINEMETA_URL}/series/${encodeURIComponent(imdb)}.json`,
      );
      return (response.meta?.videos ?? [])
        .map((video) => video.id)
        .filter((id): id is string => Boolean(id));
    } catch {
      return [];
    }
  }

  async sync(authKey: string): Promise<ProviderSyncPayload> {
    const response = await providerJson<any>('Stremio', `${API_URL}/datastoreGet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        authKey,
        collection: 'libraryItem',
        ids: [],
        all: true,
      }),
    });
    const documents: StremioLibraryItem[] = Array.isArray(response.result)
      ? response.result
      : Array.isArray(response)
        ? response
        : [];
    const items: InboundSyncItem[] = [];

    for (const document of documents) {
      const type = String(document.type ?? '').toLowerCase();
      if (type !== 'movie' && type !== 'series') continue;
      const title = document.name?.trim();
      if (!title) continue;
      const id = document._id ?? document.id ?? title;
      const imdb = imdbFrom(id);
      const ids = { imdb };
      const mediaType = type === 'movie' ? 'MOVIE' : 'SHOW';
      const activeLibraryItem = !document.removed && !document.temp;
      if (activeLibraryItem) {
        items.push({
          entityType: mediaType === 'MOVIE' ? 'WATCHLIST_MOVIE' : 'WATCHLIST_SHOW',
          mediaType,
          title,
          ids,
          sourceKey: `${type}:${id}:library`,
        });
      }

      const state = document.state ?? {};
      const timesWatched = Number(state.timesWatched ?? state.times_watched ?? 0);
      const flaggedWatched = Boolean(state.flaggedWatched ?? state.flagged_watched);
      const lastWatched =
        typeof (state.lastWatched ?? state.last_watched) === 'string'
          ? String(state.lastWatched ?? state.last_watched)
          : null;

      if (mediaType === 'MOVIE' && (timesWatched > 0 || flaggedWatched)) {
        items.push({
          entityType: 'WATCHED_MOVIE',
          mediaType,
          title,
          ids,
          watchedAt: lastWatched,
          watchCount: Math.max(1, timesWatched),
          sourceKey: `movie:${id}:watched`,
        });
        continue;
      }
      if (mediaType !== 'SHOW') continue;

      const watchedVideoIds = new Set<string>();
      if (typeof state.watched === 'string' && imdb) {
        const videos = await this.videos(imdb);
        for (const videoId of decodeStremioWatched(state.watched, videos)) {
          watchedVideoIds.add(videoId);
        }
      }
      const latestVideo = state.video_id ?? state.videoId;
      if (timesWatched > 0 && typeof latestVideo === 'string') watchedVideoIds.add(latestVideo);
      for (const videoId of watchedVideoIds) {
        const coordinates = episodeCoordinates(videoId);
        if (!coordinates || coordinates.season <= 0 || coordinates.episode <= 0) continue;
        items.push({
          entityType: 'WATCHED_EPISODE',
          mediaType: 'SHOW',
          title,
          ids,
          season: coordinates.season,
          episode: coordinates.episode,
          watchedAt: videoId === latestVideo ? lastWatched : null,
          watchCount: videoId === latestVideo ? Math.max(1, timesWatched) : 1,
          sourceKey: `series:${id}:${videoId}`,
        });
      }
    }
    return { items, cursor: null };
  }
}
