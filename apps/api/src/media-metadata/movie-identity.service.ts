import { MediaReconciler } from './reconcile/media-reconciler.service';
import { Optional } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { ExternalProvider, MediaType, Prisma, ProviderEntityKind } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { WatchForgeClient } from './providers/watchforge.client';

const identitySelect = {
  type: true,
  externalIds: true,
  canonicalSource: { select: { status: true } },
} satisfies Prisma.MediaItemSelect;

type MovieIdentityRow = Prisma.MediaItemGetPayload<{ select: typeof identitySelect }>;

function anchors(media: MovieIdentityRow | null) {
  if (!media || media.type !== MediaType.MOVIE || media.canonicalSource?.status === 'ACTIVE')
    return null;
  const ids = (provider: ExternalProvider) =>
    media.externalIds
      .filter(
        (row) => row.provider === provider && row.providerEntityKind === ProviderEntityKind.MOVIE,
      )
      .map((row) => row.value);
  const tmdb = ids(ExternalProvider.TMDB);
  const tvdb = ids(ExternalProvider.THE_TVDB);
  const imdb = ids(ExternalProvider.IMDB);
  const numeric = (value: string) =>
    /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
  if (
    [tmdb, tvdb, imdb].some((values) => values.length > 1) ||
    [...tmdb, ...tvdb].some((value) => !numeric(value)) ||
    imdb.some((value) => !/^tt\d+$/.test(value))
  )
    return null;
  return {
    tmdbId: tmdb[0] ? Number(tmdb[0]) : null,
    tvdbId: tvdb[0] ? Number(tvdb[0]) : null,
    imdbId: imdb[0] ?? null,
  };
}

/** Verifies movie IDs independently of whether their aliases can be attached locally. */
@Injectable()
export class MovieIdentityService {
  private readonly logger = new Logger(MovieIdentityService.name);
  private readonly pending = new Map<string, Promise<number | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly redis: RedisService,
    private readonly watchforge?: WatchForgeClient,
    @Optional() private readonly identities?: MediaReconciler,
  ) {}

  /** Read-only identity lookup. A duplicate local alias owner cannot invalidate provider proof. */
  resolveTvdbId(mediaId: string): Promise<number | null> {
    return this.lookup(mediaId, false);
  }

  /** Metadata enrichment may attach an unclaimed alias, but never moves one between records. */
  ensureTvdbId(mediaId: string): Promise<number | null> {
    return this.lookup(mediaId, true);
  }

  private lookup(mediaId: string, persist: boolean): Promise<number | null> {
    const key = `${persist ? 'attach' : 'resolve'}:${mediaId}`;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const work = this.enrich(mediaId, persist)
      .catch(() => {
        this.logger.warn(`Movie ID enrichment failed for ${mediaId}; retaining existing IDs`);
        return null;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, work);
    return work;
  }

  private async enrich(mediaId: string, persist: boolean): Promise<number | null> {
    if (!this.tvdb.enabled) return null;
    const before = anchors(
      await this.prisma.mediaItem.findUnique({
        where: { id: mediaId },
        select: identitySelect,
      }),
    );
    if (!before) return null;
    if (before.tvdbId) return before.tvdbId;
    if (!before.imdbId && (!before.tmdbId || !this.tmdb.enabled)) return null;
    const fingerprint = createHash('sha256').update(JSON.stringify(before)).digest('hex');
    const retryKey = `MOVIE:tvdb-identity:v3:${persist ? 'attach' : 'resolve'}:${mediaId}:${fingerprint}`;
    if (await this.redis.get(retryKey).catch(() => null)) return null;

    try {
      // Corroborate an existing IMDb anchor too, when TMDB can supply it.
      const tmdbImdb =
        before.tmdbId && this.tmdb.enabled
          ? await this.tmdb.getImdbIdForMovieStrict(before.tmdbId)
          : null;
      if (before.imdbId && tmdbImdb && before.imdbId !== tmdbImdb) {
        this.logger.warn(`Conflicting movie IMDb/TMDB anchors for ${mediaId}; no IDs changed`);
        await this.redis.set(retryKey, 'conflict', 3600).catch(() => undefined);
        return null;
      }
      let imdbId: string | null = before.imdbId ?? tmdbImdb;
      let identity: Awaited<ReturnType<TvdbProvider['getMovieIdentity']>> | null = imdbId
        ? await this.tvdb.findMovieByImdb(imdbId, before.tmdbId)
        : null;
      if (!identity && this.identities && (before.tmdbId || imdbId)) {
        const proof = await this.identities.resolveProviderIdentity(
          {
            provider: before.tmdbId ? 'tmdb' : 'imdb',
            mediaType: 'movie',
            id: before.tmdbId ? String(before.tmdbId) : imdbId!,
          },
          { lane: 'repair' },
        );
        // Disabled WatchForge is a configuration state, not an outage to retry every minute.
        if (proof.status === 'deferred' && proof.reason !== 'disabled') {
          throw new Error('Identity lookup deferred');
        }
        if (proof.status === 'verified' && proof.anchorVerified) {
          const tvdbId = Number(
            proof.externals.find((id) => id.provider === ExternalProvider.THE_TVDB)?.value,
          );
          const provedImdb =
            proof.externals.find((id) => id.provider === ExternalProvider.IMDB)?.value ?? null;
          if (imdbId && provedImdb && imdbId !== provedImdb) return null;
          if (!imdbId && provedImdb) imdbId = provedImdb;
          if (tvdbId)
            identity = {
              tvdbId,
              tmdbId:
                Number(
                  proof.externals.find((id) => id.provider === ExternalProvider.TMDB)?.value,
                ) || null,
              imdbId,
            };
        }
      } else if (!identity && imdbId && this.watchforge) {
        const result = await this.watchforge.lookup(
          {
            provider: before.tmdbId ? 'tmdb' : 'imdb',
            mediaType: 'movie',
            id: before.tmdbId ? String(before.tmdbId) : imdbId,
          },
          { lane: 'repair' },
        );
        if (result.status === 'deferred' && result.reason !== 'disabled') {
          throw new Error('Identity lookup deferred');
        }
        if (result.status === 'found' && result.identity.ids.tvdb.length === 1) {
          const evidence = result.identity.ids;
          if (
            (evidence.imdb.length && !evidence.imdb.includes(imdbId)) ||
            (before.tmdbId &&
              evidence.tmdb.length &&
              !evidence.tmdb.includes(String(before.tmdbId)))
          ) {
            await this.redis.set(retryKey, 'conflict', 3600).catch(() => undefined);
            return null;
          }
          // WatchForge proposes the candidate; a live TVDB movie must prove the bridge.
          const candidate = await this.tvdb.getMovieIdentity(Number(evidence.tvdb[0]));
          if (
            candidate.imdbId === imdbId &&
            (!before.tmdbId || candidate.tmdbId === null || candidate.tmdbId === before.tmdbId)
          ) {
            identity = candidate;
          }
        }
      }
      if (!identity) {
        await this.redis.set(retryKey, 'no-match', 3600).catch(() => undefined);
        return null;
      }
      // If TVDB lacks a TMDB link, both providers must corroborate the IMDb bridge.
      if (before.tmdbId && identity.tmdbId == null && tmdbImdb !== imdbId) return null;
      if (!persist) {
        const current = anchors(
          await this.prisma.mediaItem.findUnique({
            where: { id: mediaId },
            select: identitySelect,
          }),
        );
        return current && JSON.stringify(current) === JSON.stringify(before)
          ? identity.tvdbId
          : null;
      }
      const additions = [
        {
          mediaId,
          provider: ExternalProvider.THE_TVDB,
          providerEntityKind: ProviderEntityKind.MOVIE,
          value: String(identity.tvdbId),
        },
        ...(!before.imdbId && imdbId
          ? [
              {
                mediaId,
                provider: ExternalProvider.IMDB,
                providerEntityKind: ProviderEntityKind.MOVIE,
                value: imdbId,
              },
            ]
          : []),
      ];

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await this.prisma.$transaction(
            async (tx) => {
              // No external requests in this transaction. Recheck the identity after lookup.
              await tx.$queryRaw`SELECT id FROM media_items WHERE id = ${mediaId} FOR UPDATE`;
              const current = anchors(
                await tx.mediaItem.findUnique({
                  where: { id: mediaId },
                  select: identitySelect,
                }),
              );
              if (!current || JSON.stringify(current) !== JSON.stringify(before)) return null;
              for (const alias of additions) {
                const owner = await tx.externalId.findUnique({
                  where: {
                    provider_providerEntityKind_value: {
                      provider: alias.provider,
                      providerEntityKind: alias.providerEntityKind,
                      value: alias.value,
                    },
                  },
                  select: { mediaId: true },
                });
                if (owner && owner.mediaId !== mediaId) {
                  // Keep catalog ownership intact. Provider reads use resolveTvdbId independently.
                  this.logger.debug(
                    `Retaining ${alias.provider}/MOVIE/${alias.value} on ${owner.mediaId}; verified provider reads for ${mediaId} remain available`,
                  );
                  return null;
                }
              }
              await tx.externalId.createMany({ data: additions });
              return identity.tvdbId;
            },
            { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
          );
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (code === 'P2034' && attempt < 2) continue;
          if (code === 'P2002') return null; // A concurrent claimant won; never repoint it.
          throw error;
        }
      }
      return null;
    } catch {
      // Outages get a short retry delay, not the normal no-match interval.
      await this.redis.set(retryKey, 'retry', 60).catch(() => undefined);
      this.logger.warn(
        `Movie ID lookup temporarily unavailable for ${mediaId}; retaining existing IDs`,
      );
      return null;
    }
  }
}
