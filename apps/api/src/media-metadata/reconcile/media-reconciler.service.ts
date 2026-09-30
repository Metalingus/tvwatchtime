import { HydrationQueue } from '../hydration/hydration.queue';
import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  WatchForgeClient,
  WatchForgeProvider,
  WatchForgeResult,
  WatchForgeQuery,
  WatchForgeIdentity,
} from '../providers/watchforge.client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProviderRateLimiter } from '../../media-metadata/providers/shared/rate-limiter';
import { createHash } from 'crypto';
import { TmdbProvider } from '../providers/tmdb.provider';
import { TvdbProvider } from '../providers/tvdb.provider';
import { assertMediaIdentityWrite } from '../util/identity-write-guard';
import { canonicalMediaId } from '../util/canonical-media';
import { isProviderError } from '../providers/shared/provider-errors';

export type VerifiedIdentityResult =
  | {
      status: 'verified';
      evidence: WatchForgeIdentity;
      externals: IdentityRef[];
      ownerMediaIds: string[];
      wrongTypeOwnerIds?: string[];
      anchorVerified: boolean;
      title: string;
      year: number | null;
    }
  | { status: 'unmapped' }
  | { status: 'conflict' | 'deferred'; reason: string; retryAfterMs?: number };

export interface IdentityRef {
  provider: ExternalProvider;
  providerEntityKind: ProviderEntityKind;
  value: string;
}

export interface ReconcileOutcome {
  mediaId: string | null;
  created: boolean;
  /** When cross-provider evidence is insufficient, no merge happens and this is set. */
  needsReview?: boolean;
  attached?: IdentityRef[];
  reason?: 'owned_elsewhere' | 'conflict' | 'insufficient_evidence' | 'deferred';
  ownerMediaIds?: string[];
}

/**
 * Single shared identity-resolution + reconciliation path used by import, search
 * background hydration, promotion, admin rehydration and provider refresh.
 *
 * - `findByExternals` / `getOrCreateByIdentity` guarantee exactly-one local record per
 *   namespace-aware identity (deterministic lock + in-transaction recheck).
 * - `getOrCreateByIdentity` guarantees uniqueness FOR THE SAME identity only; cross-provider
 *   duplicates (e.g. a TMDB id and a TVDB id of the same work whose relationship is unknown)
 *   require explicit `crossProviderReconcile` with sufficient evidence.
 */
@Injectable()
export class MediaReconciler {
  private readonly logger = new Logger(MediaReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: ProviderRateLimiter,
    private readonly watchforge?: WatchForgeClient,
    private readonly tmdb?: TmdbProvider,
    private readonly tvdb?: TvdbProvider,
    @Optional() private readonly hydration?: HydrationQueue,
  ) {}

  /** A failed identity check schedules verified repair instead of depending on a maintenance script. */
  async requestIdentityRepair(mediaId: string) {
    if (!this.hydration) return;
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        type: true,
        externalIds: true,
        show: { select: { id: true } },
        movie: { select: { id: true } },
      },
    });
    if (!media) return;
    const key = createHash('sha256')
      .update(
        JSON.stringify({
          type: media.type,
          show: media.show?.id,
          movie: media.movie?.id,
          ids: media.externalIds.map((id) => [id.provider, id.providerEntityKind, id.value]).sort(),
        }),
      )
      .digest('hex')
      .slice(0, 16);
    return this.hydration.enqueueIdentityRepair(mediaId, key);
  }

  /** Find an existing media row by any verified namespace-aware external id. */
  async findByExternals(
    externals: IdentityRef[],
  ): Promise<{ id: string; title: string; type: string } | null> {
    let found: { id: string; title: string; type: string } | null = null;
    for (const e of externals) {
      const ext = await this.prisma.externalId.findFirst({
        where: { provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
        include: { media: { select: { id: true, title: true, type: true } } },
      });
      if (!ext?.media) continue;
      const expected =
        e.providerEntityKind === ProviderEntityKind.SERIES
          ? 'SHOW'
          : e.providerEntityKind === ProviderEntityKind.MOVIE
            ? 'MOVIE'
            : null;
      if (expected && ext.media.type !== expected) {
        await this.requestIdentityRepair(ext.media.id).catch(() => undefined);
        throw new ConflictException('External identity belongs to the wrong media type');
      }
      const canonical = await canonicalMediaId(this.prisma, ext.media.id);
      const target =
        canonical === ext.media.id
          ? ext.media
          : await this.prisma.mediaItem.findUnique({
              where: { id: canonical },
              select: { id: true, title: true, type: true },
            });
      if (!target || (found && found.id !== target.id)) return null;
      found = target;
    }
    return found;
  }

  /** Primary-provider crosswalk used before creation; no title matching and no writes. */
  async creationIdentities(
    identity: IdentityRef,
    requestedProvider?: ExternalProvider,
  ): Promise<IdentityRef[]> {
    if (
      ['TMDB', 'THE_TVDB'].includes(identity.provider) &&
      (!/^[1-9][0-9]*$/.test(identity.value) || !Number.isSafeInteger(Number(identity.value)))
    ) {
      throw new ConflictException('Invalid provider identity');
    }
    const result: IdentityRef[] = [identity];
    const add = (provider: ExternalProvider, value: string | number | null | undefined) => {
      if (value && !result.some((id) => id.provider === provider && id.value === String(value))) {
        result.push({
          provider,
          providerEntityKind: identity.providerEntityKind,
          value: String(value),
        });
      }
    };
    const isShow = identity.providerEntityKind === ProviderEntityKind.SERIES;
    if (!isShow && identity.providerEntityKind !== ProviderEntityKind.MOVIE) return result;
    try {
      if (identity.provider === ExternalProvider.TMDB && this.tmdb?.enabled) {
        const profile = isShow
          ? await this.tmdb.getShowRoutingProfile(Number(identity.value))
          : await this.tmdb.getMovieRoutingProfile(Number(identity.value));
        if (String(profile.tmdbId) !== identity.value)
          throw new ConflictException('Provider ID mismatch');
        add(ExternalProvider.IMDB, profile.imdbId);
        if ('tvdbId' in profile) add(ExternalProvider.THE_TVDB, profile.tvdbId);
      } else if (identity.provider === ExternalProvider.THE_TVDB && this.tvdb?.enabled) {
        const remote = isShow
          ? await this.tvdb.getShowIdentity(Number(identity.value))
          : await this.tvdb.getMovieIdentity(Number(identity.value));
        if (remote.tmdbId && this.tmdb?.enabled) {
          const profile = isShow
            ? await this.tmdb.getShowRoutingProfile(remote.tmdbId)
            : await this.tmdb.getMovieRoutingProfile(remote.tmdbId);
          if (remote.imdbId && profile.imdbId && remote.imdbId !== profile.imdbId) {
            throw new ConflictException('Provider identities disagree');
          }
          if ('tvdbId' in profile && profile.tvdbId && String(profile.tvdbId) !== identity.value) {
            throw new ConflictException('Provider identities disagree');
          }
          add(ExternalProvider.TMDB, remote.tmdbId);
          add(ExternalProvider.IMDB, profile.imdbId ?? remote.imdbId);
        } else {
          add(ExternalProvider.IMDB, remote.imdbId);
          const verified = await this.resolveProviderIdentity({
            provider: 'tvdb',
            mediaType: isShow ? 'tv' : 'movie',
            id: identity.value,
          });
          if (verified.status === 'verified' && verified.anchorVerified) return verified.externals;
          if (verified.status === 'conflict') throw new ConflictException(verified.reason);
        }
      }
      if (identity.provider === ExternalProvider.IMDB && this.tmdb?.enabled) {
        const found = await this.tmdb.findByExternalIdStrict(identity.value, 'imdb_id');
        const target = isShow ? found?.show : found?.movie;
        if (target) {
          const links = await this.creationIdentities(
            {
              provider: ExternalProvider.TMDB,
              providerEntityKind: identity.providerEntityKind,
              value: String(target.tmdbId),
            },
            requestedProvider ?? ExternalProvider.TMDB,
          );
          const imdb = links.find((id) => id.provider === ExternalProvider.IMDB);
          if (imdb && imdb.value !== identity.value)
            throw new ConflictException('Provider identities disagree');
          for (const id of links) add(id.provider, id.value);
        }
      }
      const wanted =
        requestedProvider ??
        (identity.provider === ExternalProvider.THE_TVDB ||
        identity.provider === ExternalProvider.IMDB
          ? ExternalProvider.TMDB
          : isShow
            ? ExternalProvider.THE_TVDB
            : ExternalProvider.IMDB);
      if (!result.some((id) => id.provider === wanted)) {
        // Movie providers normally expose IMDb; try their native crosswalk before WatchForge.
        const imdb = result.find((id) => id.provider === ExternalProvider.IMDB)?.value;
        if (!isShow && wanted === ExternalProvider.THE_TVDB && imdb && this.tvdb?.enabled) {
          const movie = await this.tvdb.findMovieByImdb(
            imdb,
            Number(result.find((id) => id.provider === ExternalProvider.TMDB)?.value) || null,
          );
          if (movie && movie.imdbId === imdb) add(ExternalProvider.THE_TVDB, movie.tvdbId);
        }
        if (!result.some((id) => id.provider === wanted)) {
          const provider = ({ TMDB: 'tmdb', THE_TVDB: 'tvdb', IMDB: 'imdb' } as const)[
            identity.provider as 'TMDB' | 'THE_TVDB' | 'IMDB'
          ];
          if (provider) {
            const verified = await this.resolveProviderIdentity(
              { provider, id: identity.value, mediaType: isShow ? 'tv' : 'movie' },
              { primaryOnly: !isShow && wanted !== ExternalProvider.THE_TVDB },
            );
            if (verified.status === 'verified' && verified.anchorVerified) {
              for (const known of result)
                if (
                  verified.externals.some(
                    (id) => id.provider === known.provider && id.value !== known.value,
                  )
                )
                  throw new ConflictException('Provider identities disagree');
              for (const id of verified.externals) add(id.provider, id.value);
            } else if (verified.status === 'conflict') throw new ConflictException(verified.reason);
          }
        }
      }
      return result;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isProviderError(error) && error.notFound) {
        throw new ConflictException('Provider identity no longer exists');
      }
      // An unavailable secondary provider cannot invalidate the primary namespace.
      return [identity];
    }
  }

  /** Shared missing-ID lookup for existing media. Successful local IDs never call providers. */
  async resolveMissingIds(
    requestedMediaId: string,
    wanted: ExternalProvider,
    options: { persist?: boolean } = {},
  ): Promise<IdentityRef[]> {
    const mediaId = await canonicalMediaId(this.prisma, requestedMediaId);
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true },
    });
    if (!media || !['SHOW', 'MOVIE'].includes(media.type)) return [];
    const kind = media.type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const known = media.externalIds.filter(
      (id) => id.providerEntityKind === kind && ['TMDB', 'THE_TVDB', 'IMDB'].includes(id.provider),
    ) as IdentityRef[];
    if (new Set(known.map((id) => id.provider)).size !== known.length) {
      await this.requestIdentityRepair(mediaId).catch(() => undefined);
      throw new ConflictException('Conflicting provider identities require catalog repair');
    }
    if (known.some((id) => id.provider === wanted)) return known;
    const preference =
      wanted === ExternalProvider.TMDB
        ? [ExternalProvider.THE_TVDB, ExternalProvider.IMDB, ExternalProvider.TMDB]
        : [ExternalProvider.TMDB, ExternalProvider.IMDB, ExternalProvider.THE_TVDB];
    const anchor = preference
      .map((provider) => known.find((id) => id.provider === provider))
      .find(Boolean);
    if (!anchor) return known;
    const proposed = await this.creationIdentities(anchor, wanted);
    for (const id of known)
      if (proposed.some((other) => other.provider === id.provider && other.value !== id.value))
        throw new ConflictException('Provider identities disagree');
    const links = [
      ...new Map(
        [...known, ...proposed].map((id) => [
          id.provider + ':' + id.value,
          {
            provider: id.provider,
            providerEntityKind: kind,
            value: id.value,
          },
        ]),
      ).values(),
    ];
    if (options.persist === false || links.length === known.length) return links;
    const fingerprint = (ids: IdentityRef[]) =>
      ids
        .map((id) => id.provider + ':' + id.providerEntityKind + ':' + id.value)
        .sort()
        .join('|');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM media_items WHERE id=${mediaId} FOR UPDATE`;
      const current = await tx.externalId.findMany({
        where: {
          mediaId,
          providerEntityKind: kind,
          provider: {
            in: [ExternalProvider.TMDB, ExternalProvider.THE_TVDB, ExternalProvider.IMDB],
          },
        },
      });
      if (fingerprint(current as IdentityRef[]) !== fingerprint(known))
        throw new ConflictException('Media identity changed');
      await assertMediaIdentityWrite(tx, mediaId, media.type as 'SHOW' | 'MOVIE', links);
      for (const link of links) {
        if (known.some((id) => id.provider === link.provider && id.value === link.value)) continue;
        await tx.externalId.upsert({
          where: { provider_providerEntityKind_value: link },
          create: { ...link, mediaId },
          update: {},
        });
      }
    });
    return links;
  }

  /** Corroborate the catalog's primary IDs against live, correctly typed provider records. */
  async resolveProviderIdentity(
    query: WatchForgeQuery,
    options: { fresh?: boolean; background?: boolean; primaryOnly?: boolean } = {},
  ): Promise<VerifiedIdentityResult> {
    if (!this.watchforge) return { status: 'deferred', reason: 'disabled' };
    const result = await this.watchforge.lookup(query, options);
    if (result.status !== 'found') return result;
    const evidence = result.identity;
    const primary = (name: WatchForgeProvider) =>
      evidence.primary?.[name] ?? (evidence.ids[name].length === 1 ? evidence.ids[name][0] : null);
    let tmdbId =
      query.provider === 'tmdb'
        ? Number(query.id)
        : primary('tmdb')
          ? Number(primary('tmdb'))
          : null;
    let tvdbId =
      options.primaryOnly && query.provider !== 'tvdb' && query.mediaType === 'movie'
        ? null
        : query.provider === 'tvdb'
          ? Number(query.id)
          : primary('tvdb')
            ? Number(primary('tvdb'))
            : null;
    const imdbId = primary('imdb');
    const kind = query.mediaType === 'tv' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const conflict = (reason: string): VerifiedIdentityResult => ({ status: 'conflict', reason });
    try {
      if (!tmdbId && imdbId && this.tmdb?.enabled) {
        const found = await this.tmdb.findByExternalIdStrict(imdbId, 'imdb_id');
        tmdbId = (query.mediaType === 'tv' ? found?.show?.tmdbId : found?.movie?.tmdbId) ?? null;
      }
      if (!tmdbId && !tvdbId) return { status: 'unmapped' };
      if ((tmdbId && !this.tmdb?.enabled) || (tvdbId && !this.tvdb?.enabled)) {
        return { status: 'deferred', reason: 'provider_disabled' };
      }
      const profile = tmdbId
        ? query.mediaType === 'tv'
          ? await this.tmdb!.getShowRoutingProfile(tmdbId, { bypassCache: options.fresh })
          : await this.tmdb!.getMovieRoutingProfile(tmdbId, { bypassCache: options.fresh })
        : null;
      if (profile && profile.tmdbId !== tmdbId) return conflict('provider_id_mismatch');
      if (profile?.imdbId && imdbId && profile.imdbId !== imdbId)
        return conflict('imdb_disagreement');
      const profileTvdb = profile && 'tvdbId' in profile ? profile.tvdbId : null;
      if (tvdbId && profileTvdb && tvdbId !== profileTvdb) return conflict('tvdb_disagreement');
      tvdbId ??= profileTvdb;
      if (tvdbId && !this.tvdb?.enabled) return { status: 'deferred', reason: 'provider_disabled' };
      const remote = tvdbId
        ? query.mediaType === 'tv'
          ? await this.tvdb!.getShowIdentity(tvdbId, { bypassCache: options.fresh })
          : await this.tvdb!.getMovieIdentity(tvdbId, { bypassCache: options.fresh })
        : null;
      if (remote?.imdbId && imdbId && remote.imdbId !== imdbId)
        return conflict('imdb_disagreement');
      if (remote?.tmdbId && tmdbId && remote.tmdbId !== tmdbId)
        return conflict('tmdb_disagreement');
      if (
        tmdbId &&
        tvdbId &&
        !(
          profileTvdb === tvdbId ||
          remote?.tmdbId === tmdbId ||
          (profile?.imdbId && remote?.imdbId === profile.imdbId)
        )
      ) {
        return { status: 'deferred', reason: 'unverified_crosswalk' };
      }
      let verifiedImdb = profile?.imdbId ?? remote?.imdbId ?? null;
      if (!verifiedImdb && imdbId && tmdbId && this.tmdb?.enabled) {
        const found = await this.tmdb.findByExternalIdStrict(imdbId, 'imdb_id');
        if ((query.mediaType === 'tv' ? found?.show?.tmdbId : found?.movie?.tmdbId) === tmdbId)
          verifiedImdb = imdbId;
      }
      const externals: IdentityRef[] = [];
      if (tmdbId)
        externals.push({
          provider: ExternalProvider.TMDB,
          providerEntityKind: kind,
          value: String(tmdbId),
        });
      if (tvdbId)
        externals.push({
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: kind,
          value: String(tvdbId),
        });
      if (verifiedImdb)
        externals.push({
          provider: ExternalProvider.IMDB,
          providerEntityKind: kind,
          value: verifiedImdb,
        });
      const inputProvider = {
        tmdb: ExternalProvider.TMDB,
        tvdb: ExternalProvider.THE_TVDB,
        imdb: ExternalProvider.IMDB,
      }[query.provider as 'tmdb' | 'tvdb' | 'imdb'];
      const anchorVerified = externals.some(
        (id) => id.provider === inputProvider && id.value === query.id,
      );
      const owners = await this.prisma.externalId.findMany({
        where: { OR: externals },
        select: { mediaId: true, media: { select: { type: true } } },
      });
      const wrongTypeOwnerIds = owners
        .filter((owner) => owner.media.type !== (query.mediaType === 'tv' ? 'SHOW' : 'MOVIE'))
        .map((owner) => owner.mediaId);
      return {
        status: 'verified',
        evidence,
        externals,
        anchorVerified,
        wrongTypeOwnerIds,
        ownerMediaIds: [
          ...new Set(
            await Promise.all(owners.map((owner) => canonicalMediaId(this.prisma, owner.mediaId))),
          ),
        ],
        title: profile?.title ?? evidence.title,
        year: profile
          ? 'yearStart' in profile
            ? profile.yearStart
            : profile.releaseYear
          : evidence.year,
      };
    } catch (error) {
      if (isProviderError(error) && error.notFound) return { status: 'unmapped' };
      return { status: 'deferred', reason: 'provider_unavailable' };
    }
  }

  /** Bounded catalog-only inspection. No imports, alias writes, hydration, or repair jobs. */
  async inspectMedia(mediaId: string, options: { background?: boolean } = {}) {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        externalIds: true,
        show: { select: { id: true } },
        movie: { select: { id: true } },
        _count: { select: { showStatuses: true, movieStatuses: true } },
      },
    });
    if (!media) throw new NotFoundException('Media not found');
    const kind = media.type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const providerNames: Record<string, WatchForgeProvider | undefined> = {
      TV_TIME: 'tvtime_uuid',
      [ExternalProvider.TMDB]: 'tmdb',
      [ExternalProvider.THE_TVDB]: 'tvdb',
      [ExternalProvider.IMDB]: 'imdb',
    };
    const aliases = media.externalIds.filter((id) => providerNames[id.provider]);
    const wrongKind = aliases.filter((id) => id.providerEntityKind !== kind);
    const inputs = aliases.filter((id) => id.providerEntityKind === kind);
    const observations: Array<{ input: IdentityRef; result: WatchForgeResult }> = [];
    // Surface unusually large alias sets instead of silently treating a partial audit as complete.
    for (const input of inputs.slice(0, 16)) {
      const result = this.watchforge
        ? await this.watchforge.lookup(
            {
              provider: providerNames[input.provider]!,
              mediaType: media.type === 'SHOW' ? 'tv' : 'movie',
              id: input.value,
            },
            options,
          )
        : { status: 'deferred' as const, reason: 'disabled' as const };
      observations.push({
        input: {
          provider: input.provider as ExternalProvider,
          providerEntityKind: input.providerEntityKind as ProviderEntityKind,
          value: input.value,
        },
        result,
      });
      if (result.status === 'deferred') break;
    }
    const families = new Map<string, IdentityRef[]>();
    for (const observation of observations) {
      if (observation.result.status !== 'found') continue;
      const result = observation.result.identity;
      const refs = families.get(result.wfId) ?? [];
      for (const provider of [
        ExternalProvider.TMDB,
        ExternalProvider.THE_TVDB,
        ExternalProvider.IMDB,
      ]) {
        for (const value of result.ids[providerNames[provider]!]) {
          if (!refs.some((id) => id.provider === provider && id.value === value)) {
            refs.push({ provider, providerEntityKind: kind, value });
          }
        }
      }
      families.set(result.wfId, refs);
    }
    const identities = [...families.values()].flat();
    const owners = identities.length
      ? await this.prisma.externalId.findMany({
          where: { OR: identities },
          select: {
            mediaId: true,
            provider: true,
            providerEntityKind: true,
            value: true,
            media: { select: { type: true } },
          },
        })
      : [];
    for (const owner of owners) owner.mediaId = await canonicalMediaId(this.prisma, owner.mediaId);
    const complete =
      observations.length === inputs.length &&
      observations.every(({ result }) => result.status !== 'deferred');
    const wrongStructure =
      media.type === 'MOVIE'
        ? !!media.show || (media._count?.showStatuses ?? 0) > 0
        : !!media.movie || (media._count?.movieStatuses ?? 0) > 0;
    const aliasLimit = inputs.length > 16;
    const status =
      wrongStructure ||
      aliasLimit ||
      wrongKind.length ||
      families.size > 1 ||
      owners.some((owner) => owner.media.type !== media.type) ||
      observations.some(({ result }) => result.status === 'conflict')
        ? 'conflict'
        : !complete
          ? 'deferred'
          : owners.some((owner) => owner.mediaId !== mediaId)
            ? 'owned_elsewhere'
            : families.size
              ? 'resolved'
              : 'unmapped';
    return {
      mediaId,
      status,
      reason: aliasLimit
        ? 'excessive-aliases'
        : wrongStructure
          ? 'wrong-type-structure'
          : observations.find((o) => o.result.status === 'deferred')?.result.status === 'deferred'
            ? 'provider-deferred'
            : null,
      complete,
      // These are assertions/candidates, not proof that episode graphs can be merged.
      observations,
      wrongKind,
      families: [...families].map(([wfId, ids]) => ({
        wfId,
        identities: ids,
        ownerMediaIds: [
          ...new Set(
            owners
              .filter((owner) =>
                ids.some(
                  (id) =>
                    id.provider === owner.provider &&
                    id.providerEntityKind === owner.providerEntityKind &&
                    id.value === owner.value,
                ),
              )
              .map((owner) => owner.mediaId),
          ),
        ],
      })),
    };
  }

  /** Deterministic lock key for one namespace-aware identity. */
  static identityLockKey(identity: IdentityRef): string {
    return `identity:${identity.provider}:${identity.providerEntityKind}:${identity.value}`;
  }

  /**
   * Get-or-create a local media row for one identity. `creator` performs the provider fetch
   * + lightUpsert (which attaches the external id) and returns the mediaId. Concurrent
   * promoters for the SAME identity collapse to one creation via a distinct lock + recheck.
   */
  async getOrCreateByIdentity(
    identity: IdentityRef,
    creator: () => Promise<string>,
  ): Promise<string | null> {
    const existing = await this.findByExternals([identity]);
    if (existing) return existing.id;

    const res = await this.rateLimiter.distinctLock(
      MediaReconciler.identityLockKey(identity),
      30_000,
      async () => {
        const again = await this.findByExternals([identity]);
        if (again) return again.id;
        return creator();
      },
    );
    if (res) return res;
    // Lost the single-flight race — re-read what the winner created.
    const after = await this.findByExternals([identity]);
    return after?.id ?? null;
  }

  /** Attach a newly-discovered verified identity to an existing record (no new row). */
  async attachExternalId(mediaId: string, identity: IdentityRef): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const owner = await canonicalMediaId(tx, mediaId);
        await tx.$queryRaw(Prisma.sql`SELECT id FROM media_items WHERE id=${owner} FOR UPDATE`);
        await assertMediaIdentityWrite(
          tx,
          owner,
          identity.providerEntityKind === ProviderEntityKind.MOVIE ? 'MOVIE' : 'SHOW',
          [identity],
        );
        const alias = await tx.externalId.upsert({
          where: { provider_providerEntityKind_value: identity },
          create: { mediaId: owner, ...identity },
          update: {},
        });
        if ((await canonicalMediaId(tx, alias.mediaId)) !== owner) {
          throw new ConflictException('Identity is owned elsewhere; a verified repair is required');
        }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * Deterministic cross-provider reconciliation lock derived from the sorted candidate
   * identities, so two concurrent requests comparing the same identity pair use the same key.
   */
  static reconcileLockKey(identities: IdentityRef[]): string {
    const sorted = identities
      .map((i) => `${i.provider}:${i.providerEntityKind}:${i.value}`)
      .sort()
      .join('|');
    return `RECONCILE:${createHash('sha1').update(sorted).digest('hex')}`;
  }

  /**
   * Reconcile several identities that may represent the same work. If they map to exactly
   * one compatible local record, missing verified identities may attach to it. Multiple
   * owners return a reconciliation candidate without attaching anything. If none
   * maps and confidence is high enough, the caller's `creator` builds one record and all
   * identities attach to it. If confidence is insufficient, no automatic merge happens and
   * the outcome is flagged for review (identities stay separate).
   */
  async crossProviderReconcile(
    identities: IdentityRef[],
    opts: { confidence: number; threshold?: number; creator?: () => Promise<string | null> },
  ): Promise<ReconcileOutcome> {
    const review = (
      reason: ReconcileOutcome['reason'],
      ownerMediaIds?: string[],
    ): ReconcileOutcome => ({
      mediaId: null,
      created: false,
      needsReview: true,
      reason,
      ownerMediaIds,
    });
    const kinds = new Set(identities.map((id) => id.providerEntityKind));
    if (
      !identities.length ||
      (kinds.has(ProviderEntityKind.MOVIE) && kinds.has(ProviderEntityKind.SERIES))
    ) {
      return review('conflict');
    }
    const threshold = opts.threshold ?? 0.7;
    if (
      !Number.isFinite(threshold) ||
      threshold < 0 ||
      threshold > 1 ||
      !Number.isFinite(opts.confidence) ||
      opts.confidence < threshold ||
      opts.confidence > 1
    ) {
      return review('insufficient_evidence');
    }
    const outcome = await this.rateLimiter.distinctLock(
      MediaReconciler.reconcileLockKey(identities),
      30_000,
      async () => {
        try {
          return await this.prisma.$transaction(
            async (tx) => {
              const owners = new Set<string>();
              for (const identity of identities) {
                const row = await tx.externalId.findFirst({
                  where: identity,
                  include: { media: { select: { id: true, type: true } } },
                });
                if (!row?.media) continue;
                const expected =
                  identity.providerEntityKind === ProviderEntityKind.MOVIE
                    ? 'MOVIE'
                    : identity.providerEntityKind === ProviderEntityKind.SERIES
                      ? 'SHOW'
                      : null;
                if (expected && row.media.type !== expected) return review('conflict');
                owners.add(row.media.id);
              }
              if (owners.size > 1) return review('owned_elsewhere', [...owners]);
              const existing = [...owners][0];
              const mediaId = existing ?? (opts.creator ? await opts.creator() : null);
              if (!mediaId) return review('insufficient_evidence');
              if (existing)
                await assertMediaIdentityWrite(
                  tx,
                  mediaId,
                  kinds.has(ProviderEntityKind.MOVIE) ? 'MOVIE' : 'SHOW',
                  identities,
                );
              const attached: IdentityRef[] = [];
              for (const identity of identities) {
                const row = await tx.externalId.upsert({
                  where: { provider_providerEntityKind_value: identity },
                  create: { mediaId, ...identity },
                  update: {},
                });
                if (row.mediaId !== mediaId) {
                  // Roll back any earlier additions if a concurrent claimant won.
                  throw new Error('Identity ownership changed');
                }
                attached.push(identity);
              }
              return { mediaId, created: !existing, attached };
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          if (error instanceof ConflictException) return review('conflict');
          this.logger.warn(
            'Cross-provider reconciliation deferred; identities were not reassigned',
          );
          return review('deferred');
        }
      },
    );
    // A different process won the distinct lock; never return an undefined success.
    return outcome ?? review('deferred');
  }
}
