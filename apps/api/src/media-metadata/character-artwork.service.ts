import { Injectable, Logger } from '@nestjs/common';
import {
  ExternalProvider,
  MediaCanonicalStatus,
  MediaType,
  ProviderEntityKind,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbProvider } from './providers/tmdb.provider';
import { TVDB_REMOTE_TYPE_TMDB, TvdbProvider } from './providers/tvdb.provider';

const CHARACTER_ARTWORK_VERSION = 1;
const CHARACTER_ARTWORK_PARK_MS = 90 * 24 * 60 * 60 * 1000;
const CHARACTER_ARTWORK_POLL_MS = 3000;
const CHARACTER_ARTWORK_MAX_CAST = 40;
const CHARACTER_ARTWORK_QUEUE_STALE_MS = 15 * 60 * 1000;

type ArtworkProvenance = {
  characterArtwork?: {
    version?: number;
    fingerprint?: string;
    status?: 'queued' | 'complete' | 'parked';
    reason?: string;
    checkedAt?: string;
    retryAfter?: string;
  };
};

type CastRow = {
  id: string;
  character: string | null;
  characterImageUrl: string | null;
  characterExternalId: number | null;
  sortOrder?: number;
  castMember: {
    externalId: string | null;
    tmdbId: number | null;
    tvdbId: number | null;
    name: string;
  };
};

@Injectable()
export class CharacterArtworkService {
  private readonly logger = new Logger(CharacterArtworkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: HydrationQueue,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  /**
   * Read-path trigger: never calls a provider and never delays the response with remote
   * work. It fingerprints the displayed cast and schedules one deduplicated worker.
   */
  async scheduleIfNeeded(media: {
    id: string;
    type: MediaType;
    metadataProvenance: unknown;
    cast: CastRow[];
    externalIds: {
      provider: ExternalProvider;
      providerEntityKind: ProviderEntityKind;
      value: string;
    }[];
  }): Promise<{ pending: boolean; pollAfterMs?: number }> {
    if (!this.tvdb.enabled) return { pending: false };
    const cast = media.cast
      .slice()
      .sort(
        (left, right) =>
          (left.sortOrder ?? 0) - (right.sortOrder ?? 0) || left.id.localeCompare(right.id),
      )
      .slice(0, CHARACTER_ARTWORK_MAX_CAST);
    if (!cast.length || cast.every((credit) => !!credit.characterImageUrl)) {
      return { pending: false };
    }
    const fingerprint = this.fingerprint(media, cast);
    const state = (media.metadataProvenance as ArtworkProvenance | null)?.characterArtwork;
    if (
      state?.version === CHARACTER_ARTWORK_VERSION &&
      state.fingerprint === fingerprint &&
      state.status === 'parked' &&
      state.retryAfter &&
      Date.parse(state.retryAfter) > Date.now()
    ) {
      return { pending: false };
    }
    if (
      state?.version === CHARACTER_ARTWORK_VERSION &&
      state.fingerprint === fingerprint &&
      state.status === 'complete'
    ) {
      return { pending: false };
    }
    if (
      state?.version === CHARACTER_ARTWORK_VERSION &&
      state.fingerprint === fingerprint &&
      state.status === 'queued' &&
      !!state.checkedAt &&
      Date.parse(state.checkedAt) > Date.now() - CHARACTER_ARTWORK_QUEUE_STALE_MS
    ) {
      return { pending: true, pollAfterMs: CHARACTER_ARTWORK_POLL_MS };
    }

    try {
      // Queue first: if Redis is unavailable the detail request still succeeds and the
      // title remains immediately eligible for another attempt on its next open.
      await this.queue.enqueueCharacterArtwork(media.id, fingerprint);
    } catch (error) {
      this.logger.warn(
        `character-artwork: could not queue ${media.id}: ${(error as Error).message}`,
      );
      return { pending: false };
    }
    try {
      await this.stamp(media.id, {
        version: CHARACTER_ARTWORK_VERSION,
        fingerprint,
        status: 'queued',
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      // The queued job carries its fingerprint and can still complete. Never make a
      // metadata-provenance write failure block the title detail response.
      this.logger.warn(
        `character-artwork: queued ${media.id} but could not stamp provenance: ${(error as Error).message}`,
      );
    }
    return { pending: true, pollAfterMs: CHARACTER_ARTWORK_POLL_MS };
  }

  async enrich(
    mediaId: string,
    requestedFingerprint: string,
  ): Promise<{ updated: number; status: 'complete' | 'parked'; reason?: string }> {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      include: {
        canonicalSource: { select: { status: true } },
        cast: {
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          take: CHARACTER_ARTWORK_MAX_CAST,
          include: { castMember: true },
        },
        movie: { select: { releaseDate: true } },
        externalIds: true,
      },
    });
    if (!media || media.canonicalSource?.status === MediaCanonicalStatus.ACTIVE) {
      return { updated: 0, status: 'parked', reason: 'not-visible' };
    }
    const fingerprint = this.fingerprint(media, media.cast);
    if (fingerprint !== requestedFingerprint) {
      await this.stamp(mediaId, {
        version: CHARACTER_ARTWORK_VERSION,
        fingerprint,
        status: 'parked',
        reason: 'cast-changed',
        checkedAt: new Date().toISOString(),
        retryAfter: new Date().toISOString(),
      });
      return { updated: 0, status: 'parked', reason: 'cast-changed' };
    }

    const kind =
      media.type === MediaType.MOVIE ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const providerIds = (provider: ExternalProvider) => [
      ...new Set(
        media.externalIds
          .filter((id) => id.providerEntityKind === kind && id.provider === provider)
          .map((id) => Number(id.value))
          .filter((id) => Number.isSafeInteger(id) && id > 0),
      ),
    ];
    const tmdbIds = providerIds(ExternalProvider.TMDB);
    const tvdbIds = providerIds(ExternalProvider.THE_TVDB);
    if (tmdbIds.length > 1) {
      return this.park(mediaId, fingerprint, 'ambiguous-tmdb-title-identity');
    }
    if (tvdbIds.length > 1) {
      return this.park(mediaId, fingerprint, 'ambiguous-tvdb-title-identity');
    }
    const tmdbId = tmdbIds[0];
    let tvdbId: number | null | undefined = tvdbIds[0];
    if (!Number.isSafeInteger(tvdbId) || tvdbId! <= 0) {
      if (!Number.isSafeInteger(tmdbId) || tmdbId! <= 0 || !this.tmdb.enabled) {
        return this.park(mediaId, fingerprint, 'no-verified-tvdb-title');
      }
      tvdbId =
        media.type === MediaType.MOVIE
          ? ((await this.tmdb.getTvdbIdForMovieStrict(tmdbId!)) ??
            (await this.findVerifiedTvdbMovie(media.title, media.movie?.releaseDate, tmdbId!)))
          : await this.tmdb.getTvdbIdForShowStrict(tmdbId!);
      if (!tvdbId) return this.park(mediaId, fingerprint, 'no-verified-tvdb-title');
    }
    if (tvdbId == null || !Number.isSafeInteger(tvdbId) || tvdbId <= 0) {
      return this.park(mediaId, fingerprint, 'no-verified-tvdb-title');
    }

    const snapshot =
      media.type === MediaType.MOVIE
        ? await this.tvdb.getMovie(tvdbId, 'en')
        : await this.tvdb.getShow(tvdbId, 'en', { includeStructure: false });
    if (tmdbId && snapshot.tmdbId > 0 && snapshot.tmdbId !== tmdbId) {
      return this.park(mediaId, fingerprint, 'tvdb-title-identity-conflict');
    }

    const roles = snapshot.cast.filter((role) => !!role.characterImageUrl);
    if (!roles.length) return this.park(mediaId, fingerprint, 'provider-has-no-character-images');

    const personRemoteCache = new Map<number, number | null>();
    const roleByCharacterId = new Map(
      roles
        .filter((role) => role.characterExternalId != null)
        .map((role) => [role.characterExternalId!, role]),
    );
    const updates: { castId: string; imageUrl: string; roleId?: number | null }[] = [];
    for (const credit of media.cast.filter((row) => !row.characterImageUrl)) {
      let role =
        credit.characterExternalId != null
          ? roleByCharacterId.get(credit.characterExternalId)
          : undefined;
      if (!role) {
        const candidates = [];
        for (const candidate of roles) {
          if (!(await this.personMatches(credit, candidate, personRemoteCache))) continue;
          candidates.push(candidate);
        }
        if (candidates.length === 1) {
          role = candidates[0];
        } else if (candidates.length > 1) {
          const compatible = candidates.filter((candidate) =>
            roleCompatible(credit.character, candidate.character),
          );
          if (compatible.length === 1) role = compatible[0];
        }
      }
      if (role?.characterImageUrl) {
        updates.push({
          castId: credit.id,
          imageUrl: role.characterImageUrl,
          roleId: role.characterExternalId,
        });
      }
    }

    const missingAfterUpdate =
      media.cast.filter((row) => !row.characterImageUrl).length - updates.length;
    const status = missingAfterUpdate > 0 ? 'parked' : 'complete';
    const reason = missingAfterUpdate > 0 ? 'some-roles-have-no-proven-artwork' : undefined;
    await this.prisma.$transaction(async (tx) => {
      for (const update of updates) {
        await tx.mediaCast.update({
          where: { id: update.castId },
          data: {
            characterImageUrl: update.imageUrl,
            characterExternalId: update.roleId ?? undefined,
          },
        });
        if (update.roleId != null) {
          await tx.mediaCastExternalId.upsert({
            where: {
              mediaId_provider_value: {
                mediaId,
                provider: ExternalProvider.THE_TVDB,
                value: String(update.roleId),
              },
            },
            create: {
              mediaId,
              castId: update.castId,
              provider: ExternalProvider.THE_TVDB,
              value: String(update.roleId),
            },
            update: { castId: update.castId },
          });
        }
      }
      await this.stampWith(tx, mediaId, {
        version: CHARACTER_ARTWORK_VERSION,
        fingerprint,
        status,
        reason,
        checkedAt: new Date().toISOString(),
        retryAfter:
          status === 'parked'
            ? new Date(Date.now() + CHARACTER_ARTWORK_PARK_MS).toISOString()
            : undefined,
      });
    });
    this.logger.debug(
      `character-artwork: ${mediaId} saved ${updates.length}/${media.cast.length} role image(s)`,
    );
    return { updated: updates.length, status, reason };
  }

  private async personMatches(
    credit: CastRow,
    role: {
      tmdbPersonId: number;
      personExternalId?: string;
    },
    remoteCache: Map<number, number | null>,
  ): Promise<boolean> {
    const roleTvdbPerson = parseProviderId(role.personExternalId, 'TVDB');
    const roleTmdbPerson = parseProviderId(role.personExternalId, 'TMDB');
    const creditTvdbPerson =
      credit.castMember.tvdbId ?? parseProviderId(credit.castMember.externalId, 'TVDB');
    const creditTmdbPerson =
      credit.castMember.tmdbId ?? parseProviderId(credit.castMember.externalId, 'TMDB');
    if (creditTvdbPerson && roleTvdbPerson) return creditTvdbPerson === roleTvdbPerson;
    if (creditTmdbPerson && roleTmdbPerson) return creditTmdbPerson === roleTmdbPerson;
    if (!creditTmdbPerson || !roleTvdbPerson) return false;

    let remoteTmdbId = remoteCache.get(roleTvdbPerson);
    if (remoteTmdbId === undefined) {
      const person = await this.tvdb.getPersonExtended(roleTvdbPerson);
      const remote = person?.remoteIds?.find(
        (id) => id.type === TVDB_REMOTE_TYPE_TMDB || /themoviedb|tmdb/i.test(id.sourceName ?? ''),
      )?.id;
      remoteTmdbId = remote && /^\d+$/.test(remote) ? Number(remote) : null;
      remoteCache.set(roleTvdbPerson, remoteTmdbId);
    }
    return remoteTmdbId === creditTmdbPerson;
  }

  /** TMDB movie external_ids usually has no TVDB id. Search only narrows candidates;
   * TVDB's own remote TMDB id is the required proof. */
  private async findVerifiedTvdbMovie(
    title: string,
    releaseDate: Date | null | undefined,
    tmdbId: number,
  ): Promise<number | null> {
    const result = await this.tvdb.searchMovies(title, 1);
    const normalizedTitle = normalizeRole(title);
    const year = releaseDate?.getUTCFullYear() ?? null;
    const candidates = result.items
      .filter((item) => {
        const titles = [item.title, ...(item.aliases ?? [])].map(normalizeRole);
        return (
          titles.includes(normalizedTitle) &&
          (!year || !item.year || Math.abs(item.year - year) <= 1) &&
          Number.isSafeInteger(item.tvdbId) &&
          item.tvdbId! > 0
        );
      })
      .slice(0, 8);
    const verified: number[] = [];
    for (const candidate of candidates) {
      const identity = await this.tvdb.getMovieIdentity(candidate.tvdbId!);
      if (identity.tmdbId === tmdbId) verified.push(candidate.tvdbId!);
    }
    return [...new Set(verified)].length === 1 ? verified[0] : null;
  }

  private fingerprint(
    media: {
      type: MediaType;
      externalIds: {
        provider: ExternalProvider;
        providerEntityKind: ProviderEntityKind;
        value: string;
      }[];
    },
    cast: CastRow[],
  ): string {
    const kind =
      media.type === MediaType.MOVIE ? ProviderEntityKind.MOVIE : ProviderEntityKind.SERIES;
    const ids = media.externalIds
      .filter((id) => id.providerEntityKind === kind)
      .map((id) => `${id.provider}=${id.value}`)
      .sort()
      .join(',');
    const credits = cast
      .map(
        (row) =>
          `${row.id}:${row.characterExternalId ?? ''}:${row.castMember.externalId ?? ''}:${normalizeRole(row.character)}`,
      )
      .join(',');
    return `v${CHARACTER_ARTWORK_VERSION}|${ids}|${credits}`;
  }

  private async park(
    mediaId: string,
    fingerprint: string,
    reason: string,
  ): Promise<{ updated: 0; status: 'parked'; reason: string }> {
    await this.stamp(mediaId, {
      version: CHARACTER_ARTWORK_VERSION,
      fingerprint,
      status: 'parked',
      reason,
      checkedAt: new Date().toISOString(),
      retryAfter: new Date(Date.now() + CHARACTER_ARTWORK_PARK_MS).toISOString(),
    });
    return { updated: 0, status: 'parked', reason };
  }

  private stamp(mediaId: string, state: NonNullable<ArtworkProvenance['characterArtwork']>) {
    return this.stampWith(this.prisma, mediaId, state);
  }

  private async stampWith(
    db: { $executeRaw: PrismaService['$executeRaw'] },
    mediaId: string,
    state: NonNullable<ArtworkProvenance['characterArtwork']>,
  ): Promise<void> {
    const json = JSON.stringify(state);
    await db.$executeRaw`
      UPDATE media_items
      SET metadata_provenance = COALESCE(metadata_provenance, '{}'::jsonb)
            || jsonb_build_object('characterArtwork', ${json}::jsonb)
      WHERE id = ${mediaId}`;
  }
}

function parseProviderId(value: string | undefined | null, provider: 'TMDB' | 'TVDB') {
  const match = new RegExp(`^${provider}_(\\d+)$`).exec(value ?? '');
  return match ? Number(match[1]) : null;
}

function normalizeRole(value?: string | null) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function roleCompatible(left?: string | null, right?: string | null) {
  const a = normalizeRole(left);
  const b = normalizeRole(right);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}
