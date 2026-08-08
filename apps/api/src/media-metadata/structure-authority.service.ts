import { Injectable, Logger } from '@nestjs/common';
import { StructureProvider, StructureReason } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { compareCompleteRegularStructures, StructureComparison } from './structure-comparison';
import { TmdbProvider, TmdbShowRoutingProfile } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import type { NormalizedShow } from './providers/tmdb.provider';

export const STRUCTURE_RULE_VERSION = 2;

export type ShowWriteScope =
  'STRUCTURE' | 'STRUCTURE_REMAP' | 'METADATA_ONLY' | 'CAST_ONLY' | 'ARTWORK_ONLY';

export interface StructureDecision {
  provider: StructureProvider;
  reason: StructureReason;
  ruleVersion: number;
  decidedAt: Date;
  tmdbId?: number;
  tvdbId?: number;
  imdbId?: string;
  profile?: TmdbShowRoutingProfile;
  comparison?: StructureComparison;
  /** Reused by the caller so the authority comparison does not cause duplicate full fetches. */
  tmdbSnapshot?: NormalizedShow;
  tvdbSnapshot?: NormalizedShow;
}

/** The sole automatic anime rule: TMDB genre 16 (Animation) AND keyword `anime`. */
export function isStrictTmdbAnime(genreIds: number[], keywords: string[]): boolean {
  return (
    genreIds.includes(16) && keywords.some((keyword) => keyword.trim().toLowerCase() === 'anime')
  );
}

@Injectable()
export class StructureAuthorityService {
  private readonly logger = new Logger(StructureAuthorityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  async persisted(mediaId: string): Promise<StructureDecision | null> {
    const media = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        metadataProvenance: true,
        show: {
          select: {
            structureProvider: true,
            structureReason: true,
            structureRuleVersion: true,
            structureDecidedAt: true,
          },
        },
      },
    });
    const show = media?.show;
    if (show?.structureProvider && show.structureReason) {
      return {
        provider: show.structureProvider,
        reason: show.structureReason,
        ruleVersion: show.structureRuleVersion ?? 0,
        decidedAt: show.structureDecidedAt ?? new Date(0),
      };
    }

    // Compatibility only. New writes always persist typed authority. A legacy stamp is
    // used when TMDB cannot be consulted, never as stronger evidence than a routing profile.
    const legacy = media?.metadataProvenance as Record<string, unknown> | null;
    const value = legacy?.structureProvider;
    if (value === 'tmdb' || value === 'tvdb') {
      return {
        provider: value === 'tvdb' ? StructureProvider.TVDB : StructureProvider.TMDB,
        reason:
          value === 'tvdb' ? StructureReason.TVDB_ONLY_FALLBACK : StructureReason.GENERAL_TMDB,
        ruleVersion: 0,
        decidedAt: new Date(0),
      };
    }
    return null;
  }

  async forTmdb(
    tmdbId: number,
    mediaId?: string,
    opts?: { reevaluate?: boolean },
  ): Promise<StructureDecision> {
    const existing = mediaId ? await this.persisted(mediaId) : null;
    // Existing ownership is sticky during reads/hydration. Rule upgrades and provider
    // switches run only through Metadata Health, scheduled jobs, or an import-queued
    // authority evaluation, all of which opt into reevaluation explicitly.
    if (existing && (!opts?.reevaluate || existing.reason === StructureReason.MANUAL_OVERRIDE)) {
      return {
        ...existing,
        tmdbId,
        tvdbId: mediaId ? ((await this.tvdbIdFor(mediaId)) ?? undefined) : undefined,
      };
    }

    const profile = await this.tmdb.getShowRoutingProfile(tmdbId);
    const anime = isStrictTmdbAnime(profile.genreIds, profile.keywords);
    if (anime) {
      return {
        provider: StructureProvider.TVDB,
        reason: StructureReason.ANIME_TVDB,
        ruleVersion: STRUCTURE_RULE_VERSION,
        decidedAt: new Date(),
        tmdbId: profile.tmdbId,
        tvdbId: profile.tvdbId ?? undefined,
        imdbId: profile.imdbId ?? undefined,
        profile,
      };
    }

    // A TMDB-only general show has nothing to compare and remains TMDB-owned. When a
    // verified TVDB identity exists, compare TMDB against TVDB's complete OFFICIAL graph.
    if (!profile.tvdbId || !this.tvdb.enabled) {
      return {
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
        // A configured-but-temporarily unavailable TVDB provider must be retried by the
        // authority job rather than permanently stamped as an equivalent comparison.
        ruleVersion: profile.tvdbId ? 0 : STRUCTURE_RULE_VERSION,
        decidedAt: new Date(),
        tmdbId: profile.tmdbId,
        tvdbId: profile.tvdbId ?? undefined,
        imdbId: profile.imdbId ?? undefined,
        profile,
      };
    }

    try {
      const [tmdbSnapshot, tvdbSnapshot] = await Promise.all([
        this.tmdb.getShow(profile.tmdbId, 'en-US'),
        this.tvdb.getShow(profile.tvdbId, 'en', { seasonType: 'official' }),
      ]);
      const comparison = compareCompleteRegularStructures(
        tmdbSnapshot.seasons,
        tvdbSnapshot.seasons,
      );
      const equivalent = comparison.equivalent;
      return {
        provider: equivalent ? StructureProvider.TMDB : StructureProvider.TVDB,
        reason: equivalent ? StructureReason.GENERAL_TMDB : StructureReason.GENERAL_TVDB,
        ruleVersion: STRUCTURE_RULE_VERSION,
        decidedAt: new Date(),
        tmdbId: profile.tmdbId,
        tvdbId: profile.tvdbId,
        imdbId: profile.imdbId ?? undefined,
        profile,
        comparison,
        tmdbSnapshot,
        tvdbSnapshot,
      };
    } catch (error) {
      // Provider failure means UNKNOWN, not equivalent. Existing structures stay put;
      // new stubs may use TMDB provisionally with ruleVersion=0 so health jobs retry.
      if (existing) return { ...existing, tmdbId, tvdbId: profile.tvdbId, profile };
      this.logger.warn(
        `Structure comparison deferred for TMDB ${tmdbId}/TVDB ${profile.tvdbId}: ${(error as Error).message}`,
      );
      return {
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
        ruleVersion: 0,
        decidedAt: new Date(),
        tmdbId: profile.tmdbId,
        tvdbId: profile.tvdbId,
        imdbId: profile.imdbId ?? undefined,
        profile,
      };
    }
  }

  async forTvdb(
    tvdbId: number,
    mediaId?: string,
    opts?: { reevaluate?: boolean },
  ): Promise<StructureDecision> {
    const existing = mediaId ? await this.persisted(mediaId) : null;
    if (existing && (!opts?.reevaluate || existing.reason === StructureReason.MANUAL_OVERRIDE)) {
      return {
        ...existing,
        tvdbId,
        tmdbId: mediaId ? ((await this.tmdbIdFor(mediaId)) ?? undefined) : undefined,
      };
    }

    if (this.tmdb.enabled) {
      const found = await this.tmdb.findByExternalId(String(tvdbId), 'tvdb_id');
      if (found?.show?.tmdbId) {
        return this.forTmdb(found.show.tmdbId, mediaId, opts);
      }
    }

    if (existing) return existing;
    this.logger.debug(`TVDB ${tvdbId} has no verified TMDB series mapping; using locked fallback`);
    return {
      provider: StructureProvider.TVDB,
      reason: StructureReason.TVDB_ONLY_FALLBACK,
      ruleVersion: STRUCTURE_RULE_VERSION,
      decidedAt: new Date(),
      tvdbId,
    };
  }

  async tmdbIdFor(mediaId: string): Promise<number | null> {
    const ext = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.TMDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const value = Number(ext?.value);
    return Number.isFinite(value) ? value : null;
  }

  async tvdbIdFor(mediaId: string): Promise<number | null> {
    const ext = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const value = Number(ext?.value);
    return Number.isFinite(value) ? value : null;
  }
}
