import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  MediaCanonicalStatus,
  MediaType,
  ProviderEntityKind,
  StructureProvider,
} from '@prisma/client';
import { ExternalProvider, type GalleryImageDto } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { HydrationQueue } from './hydration/hydration.queue';
import {
  type NormalizedArtwork,
  type NormalizedMovie,
  type NormalizedShow,
  TmdbProvider,
} from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { isProviderError } from './providers/shared/provider-errors';

const GALLERY_VERSION = 1;
const QUEUED_STALE_MS = 15 * 60 * 1000;
const NOT_FOUND_PARK_MS = 90 * 24 * 60 * 60 * 1000;
const GALLERY_LIMIT = 50;
const BACKDROP_LIMIT = 30;
const POSTER_LIMIT = 20;

type GalleryState = {
  version: number;
  fingerprint: string;
  status: 'queued' | 'complete' | 'parked';
  queuedAt?: string;
  checkedAt?: string;
  retryAfter?: string;
  reason?: string;
};

type Authority = {
  provider: ExternalProvider.TMDB | ExternalProvider.THE_TVDB;
  entityKind: ProviderEntityKind;
  entityId: string;
  parentEntityId?: string;
  fingerprint: string;
};

@Injectable()
export class ArtworkGalleryService {
  private readonly logger = new Logger(ArtworkGalleryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: HydrationQueue,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  async getMediaGallery(
    mediaId: string,
  ): Promise<{ gallery: GalleryImageDto[]; pending: boolean }> {
    const media = await this.loadMedia(mediaId);
    const authority = media ? this.mediaAuthority(media) : null;
    if (!media || !authority) return { gallery: [], pending: false };
    const pending = await this.scheduleIfNeeded('MEDIA', media.id, media.galleryState, authority);
    return {
      gallery: media.images
        .filter((image) => this.matchesAuthority(image, authority))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .slice(0, GALLERY_LIMIT)
        .map((image) => this.toDto(image)),
      pending,
    };
  }

  async getEpisodeGallery(
    episodeId: string,
  ): Promise<{ gallery: GalleryImageDto[]; pending: boolean }> {
    const episode = await this.loadEpisode(episodeId);
    const authority = episode ? this.episodeAuthority(episode) : null;
    if (!episode || !authority) return { gallery: [], pending: false };
    const pending = await this.scheduleIfNeeded(
      'EPISODE',
      episode.id,
      episode.galleryState,
      authority,
    );
    return {
      gallery: episode.images
        .filter((image) => this.matchesAuthority(image, authority))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        .slice(0, GALLERY_LIMIT)
        .map((image) => this.toDto(image)),
      pending,
    };
  }

  async persistMediaFromHydration(
    mediaId: string,
    source: ExternalProvider,
    data: NormalizedShow | NormalizedMovie,
  ): Promise<void> {
    if (data.artworks === undefined) return;
    const media = await this.loadMedia(mediaId);
    const authority = media ? this.mediaAuthority(media) : null;
    if (!media || !authority || authority.provider !== source) return;
    await this.persistMedia(media, authority, data.artworks);
  }

  async hydrateMedia(mediaId: string, requestedFingerprint: string): Promise<void> {
    const media = await this.loadMedia(mediaId);
    const authority = media ? this.mediaAuthority(media) : null;
    if (!media || !authority || authority.fingerprint !== requestedFingerprint) return;
    try {
      const providerId = Number(authority.entityId);
      const artworks =
        authority.provider === ExternalProvider.TMDB
          ? media.type === MediaType.SHOW
            ? await this.tmdb.getShowArtwork(providerId)
            : await this.tmdb.getMovieArtwork(providerId)
          : media.type === MediaType.SHOW
            ? await this.tvdb.getShowArtwork(providerId)
            : await this.tvdb.getMovieArtwork(providerId);
      await this.persistMedia(media, authority, artworks);
    } catch (error) {
      if (isProviderError(error) && error.notFound) {
        await this.stampMedia(mediaId, this.parked(authority, 'provider-not-found'));
        return;
      }
      throw error;
    }
  }

  async hydrateEpisode(episodeId: string, requestedFingerprint: string): Promise<void> {
    const episode = await this.loadEpisode(episodeId);
    const authority = episode ? this.episodeAuthority(episode) : null;
    if (!episode || !authority || authority.fingerprint !== requestedFingerprint) return;
    try {
      const artworks =
        authority.provider === ExternalProvider.TMDB
          ? await this.tmdb.getEpisodeArtwork(
              Number(authority.parentEntityId),
              episode.season.number,
              episode.number,
            )
          : await this.tvdb.getEpisodeArtwork(Number(authority.entityId));
      await this.persistEpisode(episode, authority, artworks);
    } catch (error) {
      if (isProviderError(error) && error.notFound) {
        await this.stampEpisode(episodeId, this.parked(authority, 'provider-not-found'));
        return;
      }
      throw error;
    }
  }

  async resolveCoverSource(
    ownerType: 'MEDIA' | 'EPISODE',
    imageId: string,
  ): Promise<{ url: string; provider: ExternalProvider.TMDB | ExternalProvider.THE_TVDB }> {
    if (ownerType === 'MEDIA') {
      const image = await this.prisma.image.findUnique({
        where: { id: imageId },
        include: {
          media: {
            include: {
              show: true,
              externalIds: true,
              canonicalSource: { select: { status: true } },
            },
          },
        },
      });
      const authority = image ? this.mediaAuthority(image.media) : null;
      if (!image || !authority || !this.matchesAuthority(image, authority)) {
        throw new NotFoundException('Gallery image not found');
      }
      return { url: image.url, provider: authority.provider };
    }
    const image = await this.prisma.episodeImage.findUnique({
      where: { id: imageId },
      include: {
        episode: {
          include: {
            externalIds: true,
            images: true,
            season: {
              include: {
                show: {
                  include: {
                    media: {
                      include: {
                        externalIds: true,
                        canonicalSource: { select: { status: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    const authority = image ? this.episodeAuthority(image.episode) : null;
    if (!image || !authority || !this.matchesAuthority(image, authority)) {
      throw new NotFoundException('Gallery image not found');
    }
    return { url: image.url, provider: authority.provider };
  }

  private async scheduleIfNeeded(
    ownerType: 'MEDIA' | 'EPISODE',
    ownerId: string,
    rawState: unknown,
    authority: Authority,
  ): Promise<boolean> {
    if (!this.providerEnabled(authority.provider)) return false;
    const state = rawState as GalleryState | null;
    if (
      state?.version === GALLERY_VERSION &&
      state.fingerprint === authority.fingerprint &&
      state.status === 'complete'
    ) {
      return false;
    }
    if (
      state?.version === GALLERY_VERSION &&
      state.fingerprint === authority.fingerprint &&
      state.status === 'parked' &&
      state.retryAfter &&
      Date.parse(state.retryAfter) > Date.now()
    ) {
      return false;
    }
    if (
      state?.version === GALLERY_VERSION &&
      state.fingerprint === authority.fingerprint &&
      state.status === 'queued' &&
      state.queuedAt &&
      Date.parse(state.queuedAt) > Date.now() - QUEUED_STALE_MS
    ) {
      return true;
    }
    try {
      await this.queue.enqueueArtworkGallery(ownerType, ownerId, authority.fingerprint);
      const queued: GalleryState = {
        version: GALLERY_VERSION,
        fingerprint: authority.fingerprint,
        status: 'queued',
        queuedAt: new Date().toISOString(),
      };
      if (ownerType === 'MEDIA') await this.stampMedia(ownerId, queued);
      else await this.stampEpisode(ownerId, queued);
      return true;
    } catch (error) {
      this.logger.warn(
        `artwork-gallery: could not queue ${ownerType}:${ownerId}: ${(error as Error).message}`,
      );
      return false;
    }
  }

  private async persistMedia(media: any, authority: Authority, artworks: NormalizedArtwork[]) {
    const selected = this.selectMediaArtwork(artworks, media.backdropUrl, media.posterUrl);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.image.deleteMany({
        where: {
          mediaId: media.id,
          provider: authority.provider,
          providerEntityKind: authority.entityKind,
          providerEntityId: authority.entityId,
        },
      });
      if (selected.length) {
        await tx.image.createMany({
          data: selected.map((artwork, sortOrder) => ({
            mediaId: media.id,
            provider: authority.provider,
            providerEntityKind: authority.entityKind,
            providerEntityId: authority.entityId,
            providerImageId: artwork.providerImageId,
            sourceKey: this.sourceKey(authority, artwork.providerImageId),
            kind: artwork.kind,
            url: artwork.url,
            previewUrl: artwork.previewUrl,
            width: artwork.width,
            height: artwork.height,
            language: artwork.language,
            includesText: artwork.includesText,
            providerRank: artwork.providerRank,
            sortOrder,
            isPrimary: this.isPrimary(artwork, media.backdropUrl, media.posterUrl),
            fetchedAt: now,
          })),
        });
      }
      const state = JSON.stringify(this.complete(authority));
      await tx.$executeRaw`
        UPDATE media_items SET gallery_state = ${state}::jsonb WHERE id = ${media.id}`;
    });
  }

  private async persistEpisode(episode: any, authority: Authority, artworks: NormalizedArtwork[]) {
    const selected = this.rank(
      artworks.filter((artwork) => artwork.kind === 'STILL'),
      episode.stillUrl,
    ).slice(0, GALLERY_LIMIT);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.episodeImage.deleteMany({
        where: {
          episodeId: episode.id,
          provider: authority.provider,
          providerEntityKind: ProviderEntityKind.EPISODE,
          providerEntityId: authority.entityId,
        },
      });
      if (selected.length) {
        await tx.episodeImage.createMany({
          data: selected.map((artwork, sortOrder) => ({
            episodeId: episode.id,
            provider: authority.provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            providerEntityId: authority.entityId,
            providerImageId: artwork.providerImageId,
            sourceKey: this.sourceKey(authority, artwork.providerImageId),
            kind: 'STILL',
            url: artwork.url,
            previewUrl: artwork.previewUrl,
            width: artwork.width,
            height: artwork.height,
            language: artwork.language,
            includesText: artwork.includesText,
            providerRank: artwork.providerRank,
            sortOrder,
            isPrimary: this.isPrimary(artwork, episode.stillUrl),
            fetchedAt: now,
          })),
        });
      }
      const state = JSON.stringify(this.complete(authority));
      await tx.$executeRaw`
        UPDATE episodes SET gallery_state = ${state}::jsonb WHERE id = ${episode.id}`;
    });
  }

  private selectMediaArtwork(
    artworks: NormalizedArtwork[],
    backdropUrl?: string | null,
    posterUrl?: string | null,
  ): NormalizedArtwork[] {
    const ranked = this.rank(artworks, backdropUrl, posterUrl);
    const backdrops = ranked.filter((artwork) => artwork.kind === 'BACKDROP');
    const posters = ranked.filter((artwork) => artwork.kind === 'POSTER');
    const selected = [...backdrops.slice(0, BACKDROP_LIMIT), ...posters.slice(0, POSTER_LIMIT)];
    const selectedKeys = new Set(selected.map((artwork) => artwork.providerImageId));
    for (const artwork of ranked) {
      if (selected.length >= GALLERY_LIMIT) break;
      if (!selectedKeys.has(artwork.providerImageId)) {
        selected.push(artwork);
        selectedKeys.add(artwork.providerImageId);
      }
    }
    return selected;
  }

  private rank(artworks: NormalizedArtwork[], ...primaryUrls: (string | null | undefined)[]) {
    const seen = new Set<string>();
    return artworks
      .filter((artwork) => {
        const key = `${artwork.kind}:${artwork.providerImageId}:${artwork.url}`;
        if (!artwork.url || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((left, right) => {
        const primary =
          Number(this.isPrimary(right, ...primaryUrls)) -
          Number(this.isPrimary(left, ...primaryUrls));
        if (primary) return primary;
        const language = this.languageScore(right) - this.languageScore(left);
        if (language) return language;
        const text = Number(left.includesText === true) - Number(right.includesText === true);
        if (text) return text;
        const rank = (right.providerRank ?? 0) - (left.providerRank ?? 0);
        if (rank) return rank;
        return (right.width ?? 0) * (right.height ?? 0) - (left.width ?? 0) * (left.height ?? 0);
      });
  }

  private languageScore(artwork: NormalizedArtwork) {
    return artwork.language == null || artwork.language === ''
      ? 2
      : artwork.language === 'en' || artwork.language === 'eng'
        ? 1
        : 0;
  }

  private isPrimary(artwork: NormalizedArtwork, ...urls: (string | null | undefined)[]) {
    return urls.some(
      (url) => !!url && (url === artwork.url || url.endsWith(artwork.providerImageId)),
    );
  }

  private mediaAuthority(media: any): Authority | null {
    if (media.canonicalSource?.status === MediaCanonicalStatus.ACTIVE) return null;
    const entityKind =
      media.type === MediaType.MOVIE ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const legacy = String(media.metadataProvenance?.structureProvider ?? '').toUpperCase();
    const hasTmdb = this.ids(media, ExternalProvider.TMDB, entityKind).length > 0;
    const hasTvdb = this.ids(media, ExternalProvider.THE_TVDB, entityKind).length > 0;
    const owner =
      media.type === MediaType.MOVIE
        ? hasTmdb
          ? ExternalProvider.TMDB
          : ExternalProvider.THE_TVDB
        : media.show?.structureProvider === StructureProvider.TVDB ||
            (!media.show?.structureProvider && (legacy === 'TVDB' || (!hasTmdb && hasTvdb)))
          ? ExternalProvider.THE_TVDB
          : ExternalProvider.TMDB;
    const ids = this.ids(media, owner, entityKind);
    if (ids.length !== 1) return null;
    const fingerprint = `v${GALLERY_VERSION}|MEDIA|${owner}|${entityKind}|${ids[0]}|${media.metadataRefreshedAt?.getTime?.() ?? 0}`;
    return { provider: owner, entityKind, entityId: ids[0], fingerprint };
  }

  private episodeAuthority(episode: any): Authority | null {
    if (episode.structureState !== 'ACTIVE') return null;
    const media = episode.season.show.media;
    if (media.canonicalSource?.status === MediaCanonicalStatus.ACTIVE) return null;
    const legacy = String(media.metadataProvenance?.structureProvider ?? '').toUpperCase();
    const hasTmdb = this.ids(media, ExternalProvider.TMDB, ProviderEntityKind.SERIES).length > 0;
    const hasTvdb =
      this.ids(media, ExternalProvider.THE_TVDB, ProviderEntityKind.SERIES).length > 0;
    const owner =
      episode.season.show.structureProvider === StructureProvider.TVDB ||
      (!episode.season.show.structureProvider && (legacy === 'TVDB' || (!hasTmdb && hasTvdb)))
        ? ExternalProvider.THE_TVDB
        : ExternalProvider.TMDB;
    const episodeIds = this.ids(episode, owner, ProviderEntityKind.EPISODE);
    const seriesIds = this.ids(media, owner, ProviderEntityKind.SERIES);
    if (episodeIds.length !== 1 || seriesIds.length !== 1) return null;
    const fingerprint = `v${GALLERY_VERSION}|EPISODE|${owner}|${seriesIds[0]}|${episodeIds[0]}|${episode.season.number}|${episode.number}|${episode.updatedAt.getTime()}`;
    return {
      provider: owner,
      entityKind: ProviderEntityKind.EPISODE,
      entityId: episodeIds[0],
      parentEntityId: seriesIds[0],
      fingerprint,
    };
  }

  private ids(row: any, provider: ExternalProvider, kind: ProviderEntityKind): string[] {
    const values: string[] = (row.externalIds ?? [])
      .filter((id: any) => id.provider === provider && id.providerEntityKind === kind)
      .map((id: any) => String(id.value))
      .filter((id: string) => /^\d+$/.test(id) && Number(id) > 0);
    return [...new Set<string>(values)];
  }

  private matchesAuthority(image: any, authority: Authority) {
    return (
      image.provider === authority.provider &&
      image.providerEntityKind === authority.entityKind &&
      image.providerEntityId === authority.entityId &&
      !!image.providerImageId &&
      ['BACKDROP', 'POSTER', 'STILL'].includes(image.kind)
    );
  }

  private toDto(image: any): GalleryImageDto {
    return {
      id: image.id,
      kind: image.kind,
      provider: image.provider,
      url: image.url,
      previewUrl: image.previewUrl,
      width: image.width,
      height: image.height,
    };
  }

  private sourceKey(authority: Authority, providerImageId: string) {
    return `${authority.provider}:${authority.entityKind}:${authority.entityId}:${providerImageId}`;
  }

  private complete(authority: Authority): GalleryState {
    return {
      version: GALLERY_VERSION,
      fingerprint: authority.fingerprint,
      status: 'complete',
      checkedAt: new Date().toISOString(),
    };
  }

  private parked(authority: Authority, reason: string): GalleryState {
    return {
      version: GALLERY_VERSION,
      fingerprint: authority.fingerprint,
      status: 'parked',
      reason,
      checkedAt: new Date().toISOString(),
      retryAfter: new Date(Date.now() + NOT_FOUND_PARK_MS).toISOString(),
    };
  }

  private providerEnabled(provider: ExternalProvider) {
    return provider === ExternalProvider.TMDB ? this.tmdb.enabled : this.tvdb.enabled;
  }

  private stampMedia(mediaId: string, state: GalleryState) {
    const json = JSON.stringify(state);
    return this.prisma.$executeRaw`
      UPDATE media_items SET gallery_state = ${json}::jsonb WHERE id = ${mediaId}`;
  }

  private stampEpisode(episodeId: string, state: GalleryState) {
    const json = JSON.stringify(state);
    return this.prisma.$executeRaw`
      UPDATE episodes SET gallery_state = ${json}::jsonb WHERE id = ${episodeId}`;
  }

  private loadMedia(mediaId: string) {
    return this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        show: true,
        externalIds: true,
        images: true,
        canonicalSource: { select: { status: true } },
      },
    });
  }

  private loadEpisode(episodeId: string) {
    return this.prisma.episode.findUnique({
      where: { id: episodeId },
      include: {
        externalIds: true,
        images: true,
        season: {
          include: {
            show: {
              include: {
                media: {
                  include: {
                    externalIds: true,
                    canonicalSource: { select: { status: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }
}
