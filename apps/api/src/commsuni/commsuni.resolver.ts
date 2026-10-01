import { assertMediaIdentityWrite } from '../media-metadata/util/identity-write-guard';
import { canonicalEpisodeTargets } from '../media-metadata/util/episode-identity';
import { MediaReconciler, IdentityRef } from '../media-metadata/reconcile/media-reconciler.service';
import { ExternalProvider } from '@tvwatch/shared';
import { ConflictException, Injectable, Optional } from '@nestjs/common';
import { MovieIdentityService } from '../media-metadata/movie-identity.service';
import { createHash } from 'crypto';
import type { ConversationType, CommsUniEntityType } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { StructureRemapService } from '../media-metadata/structure-remap.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { CommsUniClient, CommsUniError, UUID } from './commsuni.client';

export interface ResolvedConversation {
  threadType: ConversationType;
  threadId: string;
  mediaId: string;
  entityType: CommsUniEntityType;
  reference: string;
  entityId: string | null;
  fingerprint: string;
  title: string;
  showTitle?: string;
}

export class UnmappedConversation extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export function positiveProviderId(value: unknown): string | null {
  const text = String(value ?? '');
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

export function conversationFingerprint(
  type: string,
  threadId: string,
  mediaId: string,
  media: any,
  episode: any,
): string {
  const episodeIds =
    episode?.externalIds
      .filter((row: any) => row.provider === 'THE_TVDB' && row.providerEntityKind === 'EPISODE')
      .map((row: any) => positiveProviderId(row.value)) ?? [];
  return createHash('sha256')
    .update(
      JSON.stringify({
        type,
        threadId,
        mediaId,
        ids: media.externalIds
          .filter(
            (row: any) =>
              row.providerEntityKind === (type === 'MOVIE' ? 'MOVIE' : 'SERIES') &&
              (row.provider === 'THE_TVDB' ||
                row.provider === 'TMDB' ||
                (type === 'MOVIE' && row.provider === 'IMDB')),
          )
          .map((row: any) => [row.provider, row.providerEntityKind, row.value])
          .sort(),
        owner: media.show?.structureProvider,
        episodeIds: [...episodeIds].sort(),
        season: episode?.season.number,
        number: episode?.number,
      }),
    )
    .update('commsuni-mapping-v2')
    .digest('hex');
}

@Injectable()
export class CommsUniResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CommsUniClient,
    private readonly canonical: MediaCanonicalizationService,
    private readonly remap: StructureRemapService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    @Optional() private readonly movieIdentity?: MovieIdentityService,
    @Optional() private readonly identities?: MediaReconciler,
  ) {}

  private async repairableConflict(mediaId: string, reason: string): Promise<never> {
    await this.identities?.requestIdentityRepair?.(mediaId).catch(() => undefined);
    throw new UnmappedConversation(reason);
  }

  async canonicalThread(type: ConversationType, id: string): Promise<string> {
    if (!['SHOW', 'MOVIE', 'EPISODE'].includes(type))
      throw new UnmappedConversation('unsupported_thread');
    const visited = new Set<string>();
    let current = id;
    for (let depth = 0; depth < 10; depth++) {
      if (visited.has(current)) throw new UnmappedConversation('canonical_cycle');
      visited.add(current);
      let next: string | undefined;
      if (type === 'EPISODE') {
        const targets = await canonicalEpisodeTargets(this.prisma, current);
        if (targets.length !== 1) throw new UnmappedConversation('ambiguous_canonical_copy');
        next = targets[0] === current ? undefined : targets[0];
      } else {
        const link = await this.prisma.mediaCanonicalLink.findUnique({
          where: { sourceMediaId: current },
          select: { status: true, targetMediaId: true },
        });
        if (link?.status === 'ACTIVE') next = link.targetMediaId;
      }
      if (!next) {
        const stable =
          type === 'EPISODE'
            ? await this.canonical.resolveEpisodeId(id)
            : await this.canonical.resolveMediaId(id);
        if (stable !== current) throw new UnmappedConversation('canonical_mapping_changed');
        return current;
      }
      current = next;
    }
    throw new UnmappedConversation('canonical_depth');
  }

  async resolve(
    userId: string,
    type: ConversationType,
    id: string,
    options: { persist?: boolean } = {},
  ): Promise<ResolvedConversation> {
    if (!this.client.enabled) throw new UnmappedConversation('disabled');
    const threadId = await this.canonicalThread(type, id);
    const episode =
      type === 'EPISODE'
        ? await this.prisma.episode.findUnique({
            where: { id: threadId },
            include: { externalIds: true, season: { include: { show: true } } },
          })
        : null;
    if (type === 'EPISODE' && (!episode || episode.structureState !== 'ACTIVE'))
      throw new UnmappedConversation('inactive_episode');
    const mediaId = episode?.season.show.mediaId ?? threadId;
    let media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: true },
    });
    if (!media || media.type !== (type === 'MOVIE' ? 'MOVIE' : 'SHOW'))
      throw new UnmappedConversation('wrong_media_kind');
    if (this.identities) {
      try {
        await assertMediaIdentityWrite(
          this.prisma,
          mediaId,
          type === 'MOVIE' ? 'MOVIE' : 'SHOW',
          [],
        );
      } catch {
        await this.identities.requestIdentityRepair(mediaId);
        throw new UnmappedConversation('identity_repair_pending');
      }
    }
    let resolvedMovieTvdbId: string | null = null;
    let verifiedLinks: IdentityRef[] | null = null;
    if (
      !media.externalIds.some(
        (row) =>
          row.provider === 'THE_TVDB' &&
          row.providerEntityKind === (type === 'MOVIE' ? 'MOVIE' : 'SERIES'),
      ) &&
      (this.identities || (type === 'MOVIE' && this.movieIdentity))
    ) {
      const beforeLookup = conversationFingerprint(type, threadId, mediaId, media, episode);
      if (this.identities) {
        try {
          verifiedLinks = await this.identities.resolveMissingIds(
            mediaId,
            ExternalProvider.THE_TVDB,
            { persist: false },
          );
        } catch (error) {
          if (error instanceof ConflictException)
            throw new UnmappedConversation('missing_or_conflicting_media_ids');
          throw error;
        }
        resolvedMovieTvdbId = positiveProviderId(
          verifiedLinks.find((id) => id.provider === ExternalProvider.THE_TVDB)?.value,
        );
      } else
        resolvedMovieTvdbId = positiveProviderId(await this.movieIdentity!.resolveTvdbId(mediaId));
      media = await this.prisma.mediaItem.findUnique({
        where: { id: mediaId },
        include: { externalIds: true, show: true },
      });
      if (
        !media ||
        media.type !== (type === 'MOVIE' ? 'MOVIE' : 'SHOW') ||
        (await this.canonicalThread(type, id)) !== threadId
      )
        throw new UnmappedConversation('canonical_mapping_changed');
      if (conversationFingerprint(type, threadId, mediaId, media, episode) !== beforeLookup)
        throw new UnmappedConversation('movie_mapping_changed');
    }
    const expectedKind = type === 'MOVIE' ? 'MOVIE' : 'SERIES';
    const tvdbIds = media.externalIds
      .filter((row) => row.provider === 'THE_TVDB' && row.providerEntityKind === expectedKind)
      .map((row) => positiveProviderId(row.value));
    // Provider identity does not require ownership of a catalog alias. Keep the real
    // local IDs in the fingerprint; never fabricate an ExternalId or merge movie rows.
    if (tvdbIds.length === 0 && resolvedMovieTvdbId) tvdbIds.push(resolvedMovieTvdbId);
    const tmdbIds = media.externalIds
      .filter((row) => row.provider === 'TMDB' && row.providerEntityKind === expectedKind)
      .map((row) => positiveProviderId(row.value));
    if (
      tvdbIds.length !== 1 ||
      !tvdbIds[0] ||
      tmdbIds.length > 1 ||
      tmdbIds.some((value) => !value)
    )
      throw new UnmappedConversation('missing_or_conflicting_media_ids');
    const showTvdbId = tvdbIds[0];
    const episodeIds =
      episode?.externalIds
        .filter((row) => row.provider === 'THE_TVDB' && row.providerEntityKind === 'EPISODE')
        .map((row) => positiveProviderId(row.value)) ?? [];
    const fingerprint = conversationFingerprint(type, threadId, mediaId, media, episode);
    const saved = await this.prisma.commsUniBinding.findUnique({
      where: {
        scope_threadType_threadId: { scope: this.client.scope, threadType: type, threadId },
      },
    });
    const resultBase = {
      threadType: type,
      threadId,
      mediaId,
      title: episode?.title ?? media.title,
      ...(episode ? { showTitle: media.title } : {}),
      fingerprint,
    };
    // A negative binding expires too: another partner may create this conversation.
    if (
      saved?.fingerprint === fingerprint &&
      (type !== 'MOVIE' ||
        (saved.entityType === 'movie' && saved.reference === 'tvdb-' + showTvdbId)) &&
      Date.now() - saved.verifiedAt.getTime() < (saved.entityId ? 86400000 : 7200000)
    ) {
      return {
        ...resultBase,
        entityType: saved.entityType as CommsUniEntityType,
        reference: saved.reference,
        entityId: saved.entityId,
      };
    }

    if (type === 'MOVIE') {
      const identity = await this.tvdb.getMovieIdentity(Number(showTvdbId));
      const imdbIds = media.externalIds
        .filter((row) => row.provider === 'IMDB' && row.providerEntityKind === 'MOVIE')
        .map((row) => row.value);
      if (imdbIds.length > 1 || imdbIds.some((value) => !/^tt\d+$/.test(value)))
        return await this.repairableConflict(mediaId, 'movie_imdb_conflict');
      const imdb = imdbIds[0];
      if (imdb && identity.imdbId && identity.imdbId !== imdb)
        return await this.repairableConflict(mediaId, 'movie_imdb_conflict');
      if (tmdbIds[0] && String(identity.tmdbId) !== tmdbIds[0]) {
        // TVDB may expose only IMDb. Both providers must confirm that same movie.
        const bridgeImdb = imdb ?? identity.imdbId;
        if (
          identity.tmdbId != null ||
          !bridgeImdb ||
          !/^tt\d+$/.test(bridgeImdb) ||
          identity.imdbId !== bridgeImdb ||
          (await this.tmdb.getImdbIdForMovieStrict(Number(tmdbIds[0]))) !== bridgeImdb
        )
          return await this.repairableConflict(mediaId, 'movie_tmdb_conflict');
      }
    } else if (tmdbIds[0]) {
      const profile = await this.tmdb.getShowRoutingProfile(Number(tmdbIds[0]));
      if (String(profile.tvdbId) !== showTvdbId) {
        if (!verifiedLinks && this.identities) {
          const fallback = await this.identities.resolveProviderIdentity(
            { provider: 'tmdb', id: tmdbIds[0], mediaType: 'tv' },
            { lane: 'interactive' },
          );
          if (fallback.status === 'verified' && fallback.anchorVerified)
            verifiedLinks = fallback.externals;
        }
        if (
          !verifiedLinks?.some(
            (id) => id.provider === ExternalProvider.THE_TVDB && id.value === showTvdbId,
          ) ||
          !verifiedLinks.some(
            (id) => id.provider === ExternalProvider.TMDB && id.value === tmdbIds[0],
          )
        )
          return await this.repairableConflict(mediaId, 'show_tvdb_conflict');
      }
    } else if (!media.show || media.show.structureProvider !== 'TVDB') {
      throw new UnmappedConversation('unverified_tvdb_show');
    }

    const entityType: CommsUniEntityType =
      type === 'MOVIE' ? 'movie' : type === 'EPISODE' ? 'episode' : 'show';
    let reference = 'tvdb-' + showTvdbId;
    let coordinates: { season: number; episode: number } | null = null;
    if (episode) {
      // Recover a missing episode alias with the existing official structure bridge.
      // A combined broadcast still cannot become an arbitrary single shared conversation.
      if (episodeIds.length > 1 || episodeIds.some((id) => !id))
        throw new UnmappedConversation('ambiguous_episode_identity');
      const routing = await this.tvdb.getEpisodeRoutingIndex(Number(showTvdbId), 'en');
      let recoveredBridge: Awaited<
        ReturnType<StructureRemapService['resolveTvdbEpisodeAliasesToCanonical']>
      > | null = null;
      if (!episodeIds.length && media.show?.structureProvider === 'TMDB') {
        const values = [...routing.entries()]
          .filter(([, row]) => row.seasonNumber === episode.season.number)
          .map(([id]) => String(id));
        if (values.length) {
          recoveredBridge = await this.remap.resolveTvdbEpisodeAliasesToCanonical(mediaId, values);
          const candidates = [...recoveredBridge.mappings].filter(([, id]) => id === episode.id);
          if (candidates.length === 1 && values.every((id) => recoveredBridge!.mappings.has(id)))
            episodeIds.push(candidates[0][0]);
        }
      } else if (!episodeIds.length && media.show?.structureProvider === 'TVDB') {
        const candidates = [...routing.entries()].filter(
          ([, row]) =>
            row.seasonNumber === episode.season.number && row.episodeNumber === episode.number,
        );
        if (candidates.length === 1) {
          const remote = await this.tvdb.getEpisode(candidates[0][0]);
          if (
            remote.seriesId === Number(showTvdbId) &&
            remote.seasonNumber === episode.season.number &&
            remote.episode.number === episode.number &&
            remote.episode.title.trim().toLowerCase() === episode.title.trim().toLowerCase() &&
            remote.episode.airDate &&
            episode.airDate &&
            remote.episode.airDate.slice(0, 10) === episode.airDate.toISOString().slice(0, 10)
          )
            episodeIds.push(String(candidates[0][0]));
        }
      }
      if (episodeIds.length !== 1 || !episodeIds[0])
        throw new UnmappedConversation('ambiguous_episode_identity');
      const official = routing.get(Number(episodeIds[0]));
      if (!official || official.seasonNumber === null || official.episodeNumber === null)
        throw new UnmappedConversation('episode_not_in_official_show');
      if (media.show?.structureProvider === 'TMDB') {
        // A missing second alias can conceal a combined broadcast. Verify the whole season.
        const seasonIds = [...routing.entries()]
          .filter(([, item]) => item.seasonNumber === official.seasonNumber)
          .map(([value]) => String(value));
        const proof =
          recoveredBridge ??
          (await this.remap.resolveTvdbEpisodeAliasesToCanonical(mediaId, seasonIds));
        const sourcesForTarget = [...proof.mappings.values()].filter(
          (value) => value === episode.id,
        ).length;
        if (
          proof.mappings.get(episodeIds[0]) !== episode.id ||
          sourcesForTarget !== 1 ||
          seasonIds.some((value) => !proof.mappings.has(value))
        )
          throw new UnmappedConversation('episode_bridge_unproven');
      } else if (
        media.show?.structureProvider !== 'TVDB' ||
        official.seasonNumber !== episode.season.number ||
        official.episodeNumber !== episode.number
      ) {
        throw new UnmappedConversation('episode_order_conflict');
      }
      coordinates = { season: official.seasonNumber, episode: official.episodeNumber };
      reference += '-s' + coordinates.season + 'e' + coordinates.episode;
    }
    let entityId: string | null = null;
    try {
      const remote = await this.client.read<{
        entityType: string;
        entityId: string;
        tvdbId?: string | null;
        showTvdbId?: string;
        season?: number;
        episode?: number;
      }>(
        userId,
        '/entities/' + entityType,
        coordinates
          ? { tvdbShowId: showTvdbId, ...coordinates }
          : type === 'MOVIE'
            ? { identifier: showTvdbId }
            : { tvdbId: showTvdbId },
        0,
      );
      if (remote.entityType !== entityType || !UUID.test(remote.entityId))
        throw new UnmappedConversation('archive_entity_mismatch');
      if (coordinates) {
        if (
          String(remote.showTvdbId) !== showTvdbId ||
          remote.season !== coordinates.season ||
          remote.episode !== coordinates.episode ||
          (remote.tvdbId != null && String(remote.tvdbId) !== episodeIds[0])
        )
          throw new UnmappedConversation('archive_episode_mismatch');
      } else if (remote.tvdbId != null && String(remote.tvdbId) !== showTvdbId)
        throw new UnmappedConversation('archive_media_mismatch');
      entityId = remote.entityId;
    } catch (error) {
      if (!(error instanceof CommsUniError && error.empty)) throw error;
    }
    if (options.persist === false) return { ...resultBase, entityType, reference, entityId };
    const binding = await this.prisma.commsUniBinding.upsert({
      where: {
        scope_threadType_threadId: { scope: this.client.scope, threadType: type, threadId },
      },
      create: {
        scope: this.client.scope,
        threadType: type,
        threadId,
        entityType,
        reference,
        entityId,
        fingerprint,
      },
      // A late negative lookup must not overwrite the first successful publication.
      update: entityId
        ? { entityType, reference, entityId, fingerprint, verifiedAt: new Date() }
        : {},
    });
    if (!entityId) {
      if (
        binding.fingerprint === fingerprint &&
        binding.reference === reference &&
        binding.entityType === entityType &&
        binding.entityId
      )
        entityId = binding.entityId;
      else
        await this.prisma.commsUniBinding.updateMany({
          where: {
            id: binding.id,
            OR: [
              { entityId: null },
              { fingerprint: { not: fingerprint } },
              { reference: { not: reference } },
              { entityType: { not: entityType } },
            ],
          },
          data: { entityType, reference, entityId: null, fingerprint, verifiedAt: new Date() },
        });
    }
    return { ...resultBase, entityType, reference, entityId };
  }

  path(target: ResolvedConversation): string {
    return '/entities/' + target.entityType + '/' + (target.entityId ?? target.reference);
  }
}
