import { recordEpisodeRemap } from './util/episode-identity';
import { IdentityTransferManifest } from './identity-transfer-manifest';
import { canonicalCopyId, canonicalMediaId } from './util/canonical-media';
import {
  episodeProgressEligibilityWhere,
  episodeAiredWhere,
} from '../common/utils/episode-progress.util';
import { createHash } from 'crypto';
import { StructureRemapService } from './structure-remap.service';
import type { NormalizedSeason } from './providers/tmdb.provider';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CommentThreadType,
  ExternalProvider,
  MediaCanonicalRelation,
  MediaCanonicalStatus,
  MediaType,
  Prisma,
  ProviderEntityKind,
} from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { TmdbProvider } from './providers/tmdb.provider';
import { isProviderError } from './providers/shared/provider-errors';
import {
  mergeCanonicalRecommendations,
  recommendationItems,
} from './util/canonical-recommendations';
import { markPersonalizationDirty } from './personalization-cache';

type CanonicalMode = 'dry-run' | 'repair';

export type CanonicalizationRunProgress = {
  processed: number;
  total: number;
  current: string;
  candidates: number;
  activated: number;
  blocked: number;
};

type GraphEpisode = {
  id: string;
  seasonNumber: number;
  number: number;
  title: string;
  airDate: Date | null;
  runtimeMinutes: number | null;
  isSpecial: boolean;
  structureState?: string;
  externalIds: Array<{ provider: ExternalProvider; value: string }>;
};

type GraphSeason = {
  number: number;
  isSpecial: boolean;
  episodes: GraphEpisode[];
};

type ShowGraph = {
  type?: 'SHOW' | 'MOVIE';
  hasOppositeStructure?: boolean;
  id: string;
  title: string;
  normalizedTitle: string;
  structureProvider: 'TMDB' | 'TVDB' | null;
  structureReason?: string | null;
  externalIds: Array<{
    provider: ExternalProvider;
    providerEntityKind: string;
    value: string;
  }>;
  seasons: GraphSeason[];
};

type EpisodePair = { source: GraphEpisode; target: GraphEpisode };

type GraphMatch = {
  relation: MediaCanonicalRelation;
  targetSeasonNumber: number | null;
  pairs: EpisodePair[];
};

type CanonicalPlan = {
  source: ShowGraph;
  target: ShowGraph;
  match: GraphMatch;
};

export type CanonicalizationEvaluation = {
  mediaId: string;
  evaluated: boolean;
  changed: boolean;
  candidates: number;
  activated: number;
  blocked: number;
  reason?: string;
  evidence?: Record<string, unknown>;
  links: Array<{
    sourceMediaId: string;
    targetMediaId: string;
    relation: MediaCanonicalRelation;
    targetSeasonNumber: number | null;
  }>;
};

const ENTITY = {
  EPISODE: 'EPISODE',
  CAST: 'CAST',
  EPISODE_STATUS: 'EPISODE_STATUS',
  WATCH_HISTORY: 'WATCH_HISTORY',
  RATING: 'RATING',
  REACTION: 'REACTION',
  CHARACTER_VOTE: 'CHARACTER_VOTE',
  COMMENT: 'COMMENT',
  SHOW_STATUS: 'SHOW_STATUS',
  MOVIE_STATUS: 'MOVIE_STATUS',
  WATCHLIST: 'WATCHLIST',
  FAVORITE: 'FAVORITE',
  LIST_ITEM: 'LIST_ITEM',
  PROVIDER_ALERT: 'PROVIDER_ALERT',
} as const;

const CANONICAL_SCAN_CURSOR_KEY = 'media-canonicalization:scan-cursor';
const CANONICAL_SCAN_COMPLETE_KEY = 'media-canonicalization:scan-complete';
const CANONICAL_SCAN_STATE_TTL_SECONDS = 365 * 24 * 60 * 60;

function norm(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function day(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function episodeEquivalent(source: GraphEpisode, target: GraphEpisode): boolean {
  const sourceDay = day(source.airDate);
  const targetDay = day(target.airDate);
  return (
    !!sourceDay &&
    sourceDay === targetDay &&
    !!norm(source.title) &&
    norm(source.title) === norm(target.title)
  );
}

function preferIncoming(
  source: { source?: string | null; updatedAt?: Date | null; createdAt: Date },
  target: { source?: string | null; updatedAt?: Date | null; createdAt: Date },
) {
  if (!target.source || target.source === 'MANUAL') return false;
  if (!source.source || source.source === 'MANUAL') return true;
  return newest(source, target);
}

function newest(
  source: { updatedAt?: Date | null; createdAt: Date },
  target: { updatedAt?: Date | null; createdAt: Date },
) {
  return (
    (source.updatedAt ?? source.createdAt).getTime() >
    (target.updatedAt ?? target.createdAt).getTime()
  );
}

@Injectable()
export class MediaCanonicalizationService {
  private readonly logger = new Logger(MediaCanonicalizationService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
    private readonly remap?: StructureRemapService,
  ) {}

  /** Resolve old show URLs, cached IDs, and import matches only after a verified cutover. */
  async resolveMediaId(mediaId: string, expectedType?: 'SHOW' | 'MOVIE'): Promise<string> {
    return canonicalMediaId(this.prisma, mediaId, expectedType);
  }

  /** Resolve old episode URLs and provider matches through the immutable episode copy map. */
  async resolveEpisodeId(episodeId: string): Promise<string> {
    return canonicalCopyId(this.prisma, 'EPISODE', episodeId);
  }

  async getStats() {
    const [scanCursor, scanCompletedAt] = await Promise.all([
      this.redis.get<string>(CANONICAL_SCAN_CURSOR_KEY),
      this.redis.get<string>(CANONICAL_SCAN_COMPLETE_KEY),
    ]);
    const [active, copying, failed, scanRows] = await Promise.all([
      this.prisma.mediaCanonicalLink.count({ where: { status: MediaCanonicalStatus.ACTIVE } }),
      this.prisma.mediaCanonicalLink.count({ where: { status: MediaCanonicalStatus.COPYING } }),
      this.prisma.mediaCanonicalLink.count({ where: { status: MediaCanonicalStatus.FAILED } }),
      this.prisma.$queryRaw<{ total: bigint; remaining: bigint }[]>`
        WITH eligible AS (
          SELECT m.id
          FROM media_items m
          JOIN shows sh ON sh.media_id = m.id
          WHERE m.type = 'SHOW'
            AND m.content_classification = 'GENERAL'
            AND sh.structure_provider = 'TVDB'
            AND NOT EXISTS (
              SELECT 1 FROM media_canonical_links link
              WHERE link.source_media_id = m.id AND link.status = 'ACTIVE'
            )
            AND (
              SELECT count(*) FROM seasons season
              WHERE season.show_id = sh.id
                AND NOT season.is_special
                AND EXISTS (
                  SELECT 1 FROM episodes episode
                  WHERE episode.season_id = season.id AND episode.structure_state = 'ACTIVE'
                )
            ) >= 2
        )
        SELECT count(*)::bigint AS total,
               count(*) FILTER (
                 WHERE (${scanCursor ?? ''} = '' OR id > ${scanCursor ?? ''})
               )::bigint AS remaining
        FROM eligible`,
    ]);
    const scanEligible = Number(scanRows[0]?.total ?? 0);
    const scanRemaining = scanCompletedAt ? 0 : Number(scanRows[0]?.remaining ?? scanEligible);
    return {
      active,
      copying,
      failed,
      scanEligible,
      scanRemaining,
      scanProcessed: Math.max(0, scanEligible - scanRemaining),
      scanCursor,
      scanPassComplete: Boolean(scanCompletedAt),
      scanCompletedAt,
    };
  }

  async run(options: {
    mode: CanonicalMode;
    mediaId?: string;
    count?: number;
    cursor?: string;
    onProgress?: (progress: CanonicalizationRunProgress) => void;
  }) {
    const requestedCount = Number(options.count ?? 25);
    const count = Number.isFinite(requestedCount)
      ? Math.max(1, Math.min(Math.floor(requestedCount), 100))
      : 25;
    let repairPassRestarted = false;
    let cursor = options.mediaId ? undefined : options.cursor;
    if (!options.mediaId && options.mode === 'repair' && cursor == null) {
      const [savedCursor, completedAt] = await Promise.all([
        this.redis.get<string>(CANONICAL_SCAN_CURSOR_KEY),
        this.redis.get<string>(CANONICAL_SCAN_COMPLETE_KEY),
      ]);
      if (completedAt) {
        await Promise.all([
          this.redis.del(CANONICAL_SCAN_CURSOR_KEY),
          this.redis.del(CANONICAL_SCAN_COMPLETE_KEY),
        ]);
        repairPassRestarted = true;
      } else {
        cursor = savedCursor ?? undefined;
      }
    }
    const ids = options.mediaId
      ? [options.mediaId]
      : (
          await this.prisma.$queryRaw<{ id: string }[]>`
            SELECT m.id
            FROM media_items m
            JOIN shows sh ON sh.media_id = m.id
            WHERE m.type = 'SHOW'
              AND m.content_classification = 'GENERAL'
              AND sh.structure_provider = 'TVDB'
              AND (${cursor ?? ''} = '' OR m.id > ${cursor ?? ''})
              AND NOT EXISTS (
                SELECT 1 FROM media_canonical_links link
                WHERE link.source_media_id = m.id AND link.status = 'ACTIVE'
              )
              AND (
                SELECT count(*) FROM seasons season
                WHERE season.show_id = sh.id
                  AND NOT season.is_special
                  AND EXISTS (
                    SELECT 1 FROM episodes episode
                    WHERE episode.season_id = season.id AND episode.structure_state = 'ACTIVE'
                  )
              ) >= 2
            ORDER BY m.id ASC
            LIMIT ${count}`
        ).map((row) => row.id);

    const results: CanonicalizationEvaluation[] = [];
    let candidates = 0;
    let activated = 0;
    let blocked = 0;
    for (const mediaId of ids) {
      options.onProgress?.({
        processed: results.length,
        total: ids.length,
        current: mediaId,
        candidates,
        activated,
        blocked,
      });
      const result = await this.evaluateTvdbAggregate(mediaId, options.mode);
      results.push(result);
      candidates += result.candidates;
      activated += result.activated;
      blocked += result.blocked;
      options.onProgress?.({
        processed: results.length,
        total: ids.length,
        current: mediaId,
        candidates,
        activated,
        blocked,
      });
    }
    const nextCursor =
      !options.mediaId && ids.length === count ? (ids[ids.length - 1] ?? null) : null;
    let passComplete = false;
    if (!options.mediaId && options.mode === 'repair') {
      const lastProcessedCursor = ids[ids.length - 1] ?? cursor ?? null;
      if (lastProcessedCursor) {
        await this.redis.set(
          CANONICAL_SCAN_CURSOR_KEY,
          lastProcessedCursor,
          CANONICAL_SCAN_STATE_TTL_SECONDS,
        );
      }
      if (nextCursor) {
        await this.redis.del(CANONICAL_SCAN_COMPLETE_KEY);
      } else {
        passComplete = true;
        await this.redis.set(
          CANONICAL_SCAN_COMPLETE_KEY,
          new Date().toISOString(),
          CANONICAL_SCAN_STATE_TTL_SECONDS,
        );
      }
    }
    return {
      mode: options.mode,
      cursor: cursor ?? null,
      nextCursor,
      passComplete,
      repairPassRestarted,
      scanned: results.length,
      candidates,
      activated,
      blocked,
      results,
    };
  }

  /**
   * Detect TMDB full duplicates and TMDB "one season = one show" components around a
   * TVDB-owned aggregate. The detector fails closed: a component group must cover every
   * regular TVDB season and every episode must be proven by TVDB episode id through TMDB.
   */
  async evaluateTvdbAggregate(
    mediaId: string,
    mode: CanonicalMode = 'repair',
  ): Promise<CanonicalizationEvaluation> {
    const empty = (
      reason: string,
      evidence?: Record<string, unknown>,
    ): CanonicalizationEvaluation => ({
      mediaId,
      evaluated: true,
      changed: false,
      candidates: 0,
      activated: 0,
      blocked: 0,
      reason,
      evidence,
      links: [],
    });
    if (this.inFlight.has(mediaId)) return empty('already-running');
    this.inFlight.add(mediaId);
    try {
      const activeLink = await this.prisma.mediaCanonicalLink.findUnique({
        where: { sourceMediaId: mediaId },
        select: {
          targetMediaId: true,
          relation: true,
          targetSeasonNumber: true,
          status: true,
          evidence: true,
        },
      });
      if (activeLink?.status === MediaCanonicalStatus.ACTIVE) {
        return {
          mediaId,
          evaluated: true,
          changed: false,
          candidates: 1,
          activated: 0,
          blocked: 0,
          reason: 'already-active',
          evidence:
            activeLink.evidence && typeof activeLink.evidence === 'object'
              ? (activeLink.evidence as Record<string, unknown>)
              : undefined,
          links: [
            {
              sourceMediaId: mediaId,
              targetMediaId: activeLink.targetMediaId,
              relation: activeLink.relation,
              targetSeasonNumber: activeLink.targetSeasonNumber,
            },
          ],
        };
      }
      const aggregate = await this.loadGraph(mediaId);
      if (!aggregate) return empty('show-not-found');
      if (aggregate.structureProvider !== 'TVDB') return empty('not-tvdb-owned');
      const targetSeasons = aggregate.seasons.filter((season) => !season.isSpecial);
      if (targetSeasons.length < 2) return empty('not-a-multi-season-aggregate');
      const tvdbId = this.externalId(aggregate, ExternalProvider.THE_TVDB);
      if (!tvdbId) return empty('missing-tvdb-series-id');

      const dates = targetSeasons
        .flatMap((season) => season.episodes)
        .map((episode) => episode.airDate?.getTime())
        .filter((value): value is number => value != null);
      if (dates.length === 0) return empty('missing-episode-dates');
      const start = new Date(Math.min(...dates) - 86_400_000);
      const end = new Date(Math.max(...dates) + 86_400_000);

      // Discover season-component shows from provider identity, not catalog popularity.
      // One successful representative per season is enough to find the local TMDB parent;
      // verifyComponentIdentity later proves every episode before any cutover can activate.
      let providerBlocked = 0;
      const routedTmdbIds = new Set<string>();
      const episodeFindCache = new Map<string, any>();
      for (const season of targetSeasons) {
        let seasonResolved = false;
        let seasonProviderFailed = false;
        const samples = [
          season.episodes[0],
          season.episodes[Math.floor(season.episodes.length / 2)],
          season.episodes[season.episodes.length - 1],
        ].filter((row, index, rows): row is GraphEpisode => !!row && rows.indexOf(row) === index);
        for (const sample of samples) {
          const tvdbEpisodeId = sample.externalIds.find(
            (external) => external.provider === ExternalProvider.THE_TVDB,
          )?.value;
          if (!tvdbEpisodeId) continue;
          try {
            const found = await this.tmdb.findByExternalIdStrict(tvdbEpisodeId, 'tvdb_id');
            episodeFindCache.set(tvdbEpisodeId, found);
            if (found?.episode?.showId) {
              routedTmdbIds.add(String(found.episode.showId));
              seasonResolved = true;
              break;
            }
          } catch {
            seasonProviderFailed = true;
          }
        }
        if (!seasonResolved && seasonProviderFailed) providerBlocked++;
      }

      const identityCandidateIds = (
        await this.prisma.externalId.findMany({
          where: {
            mediaId: { not: aggregate.id },
            providerEntityKind: ProviderEntityKind.SERIES,
            OR: [
              { provider: ExternalProvider.THE_TVDB, value: tvdbId },
              ...(routedTmdbIds.size
                ? [
                    {
                      provider: ExternalProvider.TMDB,
                      value: { in: [...routedTmdbIds] },
                    },
                  ]
                : []),
            ],
            media: {
              type: MediaType.SHOW,
              OR: [
                { canonicalSource: { is: null } },
                { canonicalSource: { is: { status: { not: MediaCanonicalStatus.ACTIVE } } } },
              ],
            },
          },
          select: { mediaId: true },
        })
      ).map((row) => row.mediaId);

      // A full TMDB anthology may have no direct TVDB series id because each TVDB episode
      // resolves to one of TMDB's season-as-show components. Do not rely on catalog
      // popularity to discover that aggregate: select local TMDB graphs with the same
      // complete regular-season/episode shape and date boundaries, then let matchGraph
      // prove every individual title/date pair below.
      const targetEpisodeCount = targetSeasons.reduce(
        (count, season) => count + season.episodes.length,
        0,
      );
      const firstAirDate = new Date(Math.min(...dates));
      const lastAirDate = new Date(Math.max(...dates));
      const shapeCandidateIds = (
        await this.prisma.$queryRaw<{ media_id: string }[]>`
          SELECT sh.media_id
          FROM shows sh
          JOIN media_items m ON m.id = sh.media_id
          JOIN seasons season ON season.show_id = sh.id AND NOT season.is_special
          JOIN episodes episode ON episode.season_id = season.id
            AND episode.structure_state = 'ACTIVE'
          WHERE sh.media_id <> ${aggregate.id}
            AND sh.structure_provider = 'TMDB'
            AND m.type = 'SHOW'
            AND m.content_classification = 'GENERAL'
            AND NOT EXISTS (
              SELECT 1 FROM media_canonical_links link
              WHERE link.source_media_id = sh.media_id AND link.status = 'ACTIVE'
            )
          GROUP BY sh.media_id
          HAVING count(DISTINCT season.id) = ${targetSeasons.length}
            AND count(episode.id) = ${targetEpisodeCount}
            AND count(episode.air_date) = ${targetEpisodeCount}
            AND min(episode.air_date)::date = ${firstAirDate}::date
            AND max(episode.air_date)::date = ${lastAirDate}::date
          ORDER BY sh.media_id ASC
          LIMIT 250`
      ).map((row) => row.media_id);

      const dateCandidateIds = (
        await this.prisma.mediaItem.findMany({
          where: {
            id: { not: aggregate.id },
            type: MediaType.SHOW,
            contentClassification: 'GENERAL',
            show: {
              is: {
                structureProvider: 'TMDB',
                seasons: {
                  some: {
                    episodes: {
                      some: {
                        structureState: 'ACTIVE',
                        airDate: { gte: start, lte: end },
                      },
                    },
                  },
                },
              },
            },
            OR: [
              { canonicalSource: { is: null } },
              { canonicalSource: { is: { status: { not: MediaCanonicalStatus.ACTIVE } } } },
            ],
          },
          select: { id: true },
          orderBy: { popularity: 'desc' },
          take: 250,
        })
      ).map((row) => row.id);
      const candidateIds = [
        ...new Set([...identityCandidateIds, ...shapeCandidateIds, ...dateCandidateIds]),
      ];

      const exact: Array<{
        graph: ShowGraph;
        match: GraphMatch;
        state: 'direct' | 'unlinked' | 'dead';
      }> = [];
      const components: Array<{ graph: ShowGraph; match: GraphMatch }> = [];
      for (const candidateId of candidateIds) {
        const graph = await this.loadGraph(candidateId);
        if (!graph) continue;
        const match = this.matchGraph(graph, aggregate);
        if (!match) continue;
        if (match.relation === MediaCanonicalRelation.EXACT_DUPLICATE) {
          const tmdbId = Number(this.externalId(graph, ExternalProvider.TMDB));
          if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) continue;
          try {
            const profile = await this.tmdb.getShowRoutingProfile(tmdbId);
            const profileTvdbId = String(profile.tvdbId ?? '');
            if (profileTvdbId === tvdbId) exact.push({ graph, match, state: 'direct' });
            else if (!profileTvdbId) exact.push({ graph, match, state: 'unlinked' });
            else providerBlocked++;
          } catch (error) {
            if (isProviderError(error) && error.category === 'not_found') {
              // Keep an episode-identical dead-provider graph as a candidate. It is never
              // allowed to own the family, and a title mismatch may be trusted only after
              // the complete component set independently proves the aggregate identity.
              exact.push({ graph, match, state: 'dead' });
            } else {
              providerBlocked++;
            }
          }
        } else {
          components.push({ graph, match });
        }
      }

      const componentsBySeason = new Map<number, Array<{ graph: ShowGraph; match: GraphMatch }>>();
      for (const component of components) {
        const season = component.match.targetSeasonNumber!;
        const bucket = componentsBySeason.get(season) ?? [];
        bucket.push(component);
        componentsBySeason.set(season, bucket);
      }
      const completeComponentSet = targetSeasons.every(
        (season) => componentsBySeason.get(season.number)?.length === 1,
      );
      const verifiedComponents: Array<{ graph: ShowGraph; match: GraphMatch }> = [];
      let componentSetVerified = false;
      if (completeComponentSet) {
        componentSetVerified = true;
        for (const season of targetSeasons) {
          const component = componentsBySeason.get(season.number)![0];
          if (
            !(await this.verifyComponentIdentity(
              component.graph,
              component.match,
              episodeFindCache,
            ))
          ) {
            providerBlocked++;
            componentSetVerified = false;
            break;
          }
          verifiedComponents.push(component);
        }
      }

      const directExact = exact.filter((row) => row.state === 'direct');
      if (directExact.length > 1) {
        return empty('multiple-direct-tmdb-roots', {
          directRootIds: directExact.map((row) => row.graph.id),
        });
      }
      const transitiveExact = exact.filter((row) => row.state === 'unlinked');
      if (!directExact.length && componentSetVerified && transitiveExact.length > 1) {
        return empty('multiple-transitive-tmdb-roots', {
          transitiveRootIds: transitiveExact.map((row) => row.graph.id),
        });
      }

      // Equivalent general-TV graphs are TMDB-owned. A TMDB aggregate without its own
      // TVDB series id can still be selected when the complete component set proves every
      // official TVDB episode transitively and exactly one full TMDB graph matches it.
      const root =
        directExact[0]?.graph ??
        (componentSetVerified && transitiveExact.length === 1
          ? transitiveExact[0].graph
          : aggregate);
      const rootProof = directExact.length
        ? 'direct-tmdb-tvdb-series-identity'
        : root.id !== aggregate.id
          ? 'complete-transitive-episode-identity'
          : 'tvdb-aggregate-fallback';
      const planned: CanonicalPlan[] = [];

      if (root.id !== aggregate.id) {
        const reverse = this.matchGraph(aggregate, root);
        if (!reverse || reverse.relation !== MediaCanonicalRelation.EXACT_DUPLICATE) {
          return empty('verified-root-structure-changed');
        }
        planned.push({ source: aggregate, target: root, match: reverse });
      }

      for (const duplicate of exact) {
        if (duplicate.graph.id === root.id) continue;
        // An unlinked full graph is not independently authoritative. It may be hidden only
        // when another TMDB root has already been proven directly or transitively.
        if (duplicate.state === 'unlinked' && root.id === aggregate.id) continue;
        // A dead TMDB id cannot prove its own provider identity. Preserve the stricter
        // title guard unless the independently verified, complete component family proves
        // that this episode-identical full graph is the same aggregate.
        if (
          duplicate.state === 'dead' &&
          norm(duplicate.graph.title) !== norm(aggregate.title) &&
          !componentSetVerified
        ) {
          continue;
        }
        const match = this.matchGraph(duplicate.graph, root);
        if (match?.relation === MediaCanonicalRelation.EXACT_DUPLICATE) {
          planned.push({ source: duplicate.graph, target: root, match });
        }
      }

      // Full-season component consolidation is one identity proof. Never activate a
      // subset: either every official season is proven and maps to the chosen root or every
      // component remains visible.
      if (componentSetVerified) {
        for (const component of verifiedComponents) {
          const rootMatch = this.matchGraph(component.graph, root);
          if (rootMatch?.relation !== MediaCanonicalRelation.SEASON_COMPONENT) {
            return empty('component-does-not-match-canonical-root', {
              componentMediaId: component.graph.id,
              rootMediaId: root.id,
            });
          }
          planned.push({ source: component.graph, target: root, match: rootMatch });
        }
      }

      const uniquePlanned = [...new Map(planned.map((row) => [row.source.id, row])).values()];
      const links = uniquePlanned.map((row) => ({
        sourceMediaId: row.source.id,
        targetMediaId: row.target.id,
        relation: row.match.relation,
        targetSeasonNumber: row.match.targetSeasonNumber,
      }));
      const evidence = {
        aggregateMediaId: aggregate.id,
        tvdbId,
        rootMediaId: root.id,
        rootProof,
        officialSeasonCount: targetSeasons.length,
        exactCandidates: exact.map((row) => ({ id: row.graph.id, state: row.state })),
        componentCandidatesBySeason: Object.fromEntries(
          [...componentsBySeason].map(([season, rows]) => [
            season,
            rows.map((row) => row.graph.id),
          ]),
        ),
        completeComponentSet,
        componentSetVerified,
        providerBlocked,
      };
      if (mode === 'dry-run') {
        return {
          mediaId,
          evaluated: true,
          changed: false,
          candidates: links.length,
          activated: 0,
          blocked: providerBlocked,
          reason: links.length
            ? undefined
            : completeComponentSet
              ? 'identity-proof-failed'
              : 'no-complete-component-set',
          evidence,
          links,
        };
      }

      let activated = 0;
      let blocked = providerBlocked;
      if (uniquePlanned.length > 0) {
        try {
          activated = await this.consolidatePlan(uniquePlanned, evidence);
        } catch (error) {
          blocked += uniquePlanned.length;
          this.logger.warn(
            `canonicalize plan ${aggregate.id} -> ${root.id} blocked atomically: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return {
        mediaId,
        evaluated: true,
        changed: activated > 0,
        candidates: links.length,
        activated,
        blocked,
        reason: links.length ? undefined : 'no-safe-canonical-links',
        evidence,
        links,
      };
    } finally {
      this.inFlight.delete(mediaId);
    }
  }

  private graphFingerprint(graphs: ShowGraph[]): string {
    return createHash('sha256')
      .update(
        JSON.stringify(
          [...graphs]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((graph) => ({
              ...graph,
              externalIds: [...graph.externalIds].sort((a, b) =>
                (a.provider + ':' + a.value).localeCompare(b.provider + ':' + b.value),
              ),
            })),
        ),
      )
      .digest('hex');
  }

  /** General duplicate path: supports movies, anime, single-season, and divergent provider graphs. */
  async identityFamily(
    mediaIds: string[],
    targetMediaId: string,
    options: {
      mode: 'dry-run' | 'repair';
      fingerprint?: string;
      verifiedIds: Array<{ provider: string; providerEntityKind: string; value: string }>;
      canonical?: 'tmdb' | 'tvdb';
      snapshot?: NormalizedSeason[];
      foreignSnapshot?: NormalizedSeason[];
      evidence?: Record<string, unknown>;
      commit?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ) {
    const ids = [...new Set(mediaIds)].sort();
    const graphs = (await Promise.all(ids.map((id) => this.loadGraph(id)))).filter(
      (g): g is ShowGraph => !!g,
    );
    const target = graphs.find((g) => g.id === targetMediaId);
    const fingerprint = this.graphFingerprint(graphs);
    const result = {
      fingerprint,
      targetMediaId,
      sourceMediaIds: ids.filter((id) => id !== targetMediaId),
      status: 'blocked',
      reason: '',
      mappings: 0,
      activated: 0,
    };
    if (!target || graphs.length !== ids.length || ids.length < 2)
      return { ...result, reason: 'missing-family-member' };
    if (options.fingerprint && options.fingerprint !== fingerprint)
      return { ...result, reason: 'stale-plan' };
    const type = target.type ?? 'SHOW';
    if (graphs.some((g) => (g.type ?? 'SHOW') !== type || g.hasOppositeStructure)) {
      return { ...result, reason: 'split-required' };
    }
    if (
      graphs.some(
        (g) =>
          g.id !== targetMediaId &&
          g.structureReason === 'MANUAL_OVERRIDE' &&
          (target.structureReason !== 'MANUAL_OVERRIDE' ||
            target.structureProvider !== g.structureProvider),
      )
    ) {
      return { ...result, reason: 'manual-authority-must-be-preserved' };
    }
    const kind = type === 'SHOW' ? 'SERIES' : 'MOVIE';
    const allowed = new Set(
      options.verifiedIds.map((id) => id.provider + ':' + id.providerEntityKind + ':' + id.value),
    );
    for (const graph of graphs) {
      const core = graph.externalIds.filter((id) =>
        ['TMDB', 'THE_TVDB', 'IMDB'].includes(id.provider),
      );
      if (
        !core.length ||
        core.some(
          (id) =>
            id.providerEntityKind !== kind ||
            !allowed.has(id.provider + ':' + id.providerEntityKind + ':' + id.value),
        )
      ) {
        return { ...result, reason: 'unverified-or-conflicting-alias' };
      }
    }
    if (type === 'SHOW') {
      if (
        !options.snapshot?.some((season) => !season.isSpecial && season.episodes.length) ||
        !options.canonical ||
        !this.remap
      ) {
        return { ...result, reason: 'complete-provider-snapshot-required' };
      }
      if (!this.snapshotMatches(target, options.canonical, options.snapshot)) {
        return { ...result, status: 'structure-required', reason: 'target-graph-is-stale' };
      }
    }
    const plans: CanonicalPlan[] = [];
    for (const source of graphs.filter((g) => g.id !== targetMediaId)) {
      let pairs: EpisodePair[] = [];
      if (type === 'SHOW') {
        const projection = await this.remap!.previewCrossMediaMapping(
          source.id,
          target.id,
          options.canonical!,
          options.foreignSnapshot,
        );
        if (projection.unmappedProtected.length)
          return { ...result, reason: 'unmapped-protected-episodes' };
        const sourceEpisodes = new Map(
          source.seasons.flatMap((s) => s.episodes).map((e) => [e.id, e]),
        );
        const targetEpisodes = new Map(
          target.seasons.flatMap((s) => s.episodes).map((e) => [e.id, e]),
        );
        for (const pair of projection.pairs)
          for (const targetId of pair.targetIds) {
            const from = sourceEpisodes.get(pair.sourceId),
              to = targetEpisodes.get(targetId);
            if (!from || !to) return { ...result, reason: 'episode-graph-changed' };
            pairs.push({ source: from, target: to });
          }
      }
      plans.push({
        source,
        target,
        match: {
          relation: MediaCanonicalRelation.EXACT_DUPLICATE,
          targetSeasonNumber: null,
          pairs,
        },
      });
      result.mappings += pairs.length;
    }
    if (options.mode === 'dry-run')
      return {
        ...result,
        status: 'ready',
        reason: 'verified-family',
        episodeMappings: this.transferMappings(plans),
      };
    const activated = await this.consolidatePlan(
      plans,
      {
        ...options.evidence,
        identityFingerprint: fingerprint,
        identityMembers: ids,
        verifiedIds: options.verifiedIds,
      },
      undefined,
      options.commit,
    );
    return { ...result, status: 'applied', reason: 'verified-family', activated };
  }

  /** Split the proven stray subtype without deleting its episodes or ambiguous media-level data. */
  async splitIdentity(
    sourceId: string,
    options: {
      mode: 'dry-run' | 'repair';
      fingerprint?: string;
      targetId?: string;
      type: 'SHOW' | 'MOVIE';
      title: string;
      verifiedIds: Array<{ provider: string; providerEntityKind: string; value: string }>;
      removeAliasIds: string[];
      allowedCastIds: string[];
      independentParentAnchor?: boolean;
      canonical?: 'tmdb' | 'tvdb';
      snapshot?: NormalizedSeason[];
      foreignSnapshot?: NormalizedSeason[];
      evidence?: Record<string, unknown>;
      commit?: (tx: Prisma.TransactionClient) => Promise<void>;
    },
  ) {
    const original = await this.loadGraph(sourceId);
    const target = options.targetId ? await this.loadGraph(options.targetId) : null;
    const graphs = [original, target].filter((g): g is ShowGraph => !!g);
    const fingerprint = this.graphFingerprint(graphs);
    const splitId =
      'cwf' +
      createHash('sha256')
        .update(
          sourceId +
            ':' +
            options.verifiedIds
              .map((id) => id.provider + ':' + id.value)
              .sort()
              .join('|'),
        )
        .digest('hex')
        .slice(0, 22);
    const result = {
      status: 'blocked',
      reason: '',
      fingerprint,
      sourceMediaId: sourceId,
      targetMediaId: target?.id ?? splitId,
      retained:
        'Untyped media ratings, reactions, watchlist, favorites, lists, alerts, and media reviews remain on the original record.',
    };
    if (
      !original ||
      original.type === options.type ||
      !original.hasOppositeStructure ||
      (options.targetId && (!target || target.type !== options.type || target.hasOppositeStructure))
    ) {
      return { ...result, reason: 'split-structure-changed' };
    }
    if (options.fingerprint && fingerprint !== options.fingerprint)
      return { ...result, reason: 'stale-plan' };
    const allowedAliases = new Set(
      options.verifiedIds.map((id) => id.provider + ':' + id.providerEntityKind + ':' + id.value),
    );
    if (
      target?.externalIds.some(
        (id) =>
          ['TMDB', 'THE_TVDB', 'IMDB'].includes(id.provider) &&
          !allowedAliases.has(id.provider + ':' + id.providerEntityKind + ':' + id.value),
      )
    ) {
      return { ...result, reason: 'split-target-has-conflicting-aliases' };
    }
    if (
      target &&
      original.structureReason === 'MANUAL_OVERRIDE' &&
      options.type === 'SHOW' &&
      (target.structureReason !== 'MANUAL_OVERRIDE' ||
        target.structureProvider !== original.structureProvider)
    ) {
      return { ...result, reason: 'manual-authority-must-be-preserved' };
    }
    const episodeRows = original.seasons.flatMap((s) => s.episodes);
    const legacyDateDriftIds = new Set<string>();
    const dualProviderDateTypoIds = new Set<string>();
    const verifiedUndatedSpecialIds = new Set<string>();
    const unprotectedLegacyIds = new Set<string>();
    if (options.type === 'SHOW') {
      const provider =
        options.canonical === 'tvdb' ? ExternalProvider.THE_TVDB : ExternalProvider.TMDB;
      const expected = new Set(
        options.snapshot?.flatMap((s) => s.episodes.map((e) => String(e.tmdbId))) ?? [],
      );
      const foreignProvider =
        provider === ExternalProvider.TMDB ? ExternalProvider.THE_TVDB : ExternalProvider.TMDB;
      const foreignIds = new Set(
        options.foreignSnapshot?.flatMap((s) => s.episodes.map((e) => String(e.tmdbId))) ?? [],
      );
      // A legacy structure can have lost all episode aliases. The parent is already
      // independently verified: require every ID-less row to agree with one official
      // snapshot in coordinates, normalized title, runtime and UTC/local air-date window.
      // Existing contradictory episode aliases never fall through to this comparison.
      const membership = (
        episode: GraphEpisode,
        maxDateDelta = 36 * 60 * 60 * 1000,
        strictRuntime = false,
      ) => {
        const core = episode.externalIds.filter(
          (id) => id.provider === provider || id.provider === foreignProvider,
        );
        if (core.length)
          return core.every(
            (id) =>
              (id.provider === provider && expected.has(id.value)) ||
              (id.provider === foreignProvider && foreignIds.has(id.value)),
          );
        if (
          episode.isSpecial &&
          !episode.airDate &&
          norm(episode.title).length >= 8 &&
          !/^(episode|special|part|pilot|tba|unknown)( |$)/.test(norm(episode.title)) &&
          [options.snapshot, options.foreignSnapshot].every((snapshot) => {
            const matches = (snapshot ?? [])
              .filter((s) => s.number === 0)
              .flatMap((s) => s.episodes)
              .filter((e) => norm(e.title) === norm(episode.title));
            return (
              matches.length === 1 && matches[0].number === episode.number && !matches[0].airDate
            );
          }) &&
          [options.snapshot, options.foreignSnapshot].some((snapshot) =>
            (snapshot ?? [])
              .filter((s) => s.number === 0)
              .flatMap((s) => s.episodes)
              .some(
                (e) =>
                  e.number === episode.number &&
                  norm(e.title) === norm(episode.title) &&
                  e.runtimeMinutes &&
                  episode.runtimeMinutes &&
                  Math.abs(e.runtimeMinutes - episode.runtimeMinutes) <= 2,
              ),
          )
        ) {
          verifiedUndatedSpecialIds.add(episode.id);
          legacyDateDriftIds.add(episode.id);
          return true;
        }
        return [options.snapshot, options.foreignSnapshot].some((snapshot) => {
          const matches = (snapshot ?? [])
            .filter((s) => s.number === episode.seasonNumber)
            .flatMap((s) => s.episodes)
            .filter((e) => {
              const date = e.airDate ? new Date(e.airDate).getTime() : NaN;
              const delta = episode.airDate ? Math.abs(episode.airDate.getTime() - date) : Infinity;
              const runtime = e.runtimeMinutes;
              if (
                strictRuntime &&
                (!runtime ||
                  !episode.runtimeMinutes ||
                  Math.abs(runtime - episode.runtimeMinutes) > 2)
              )
                return false;
              return (
                e.number === episode.number &&
                !!norm(episode.title) &&
                norm(episode.title) === norm(e.title) &&
                delta <= maxDateDelta &&
                (!runtime ||
                  !episode.runtimeMinutes ||
                  Math.abs(runtime - episode.runtimeMinutes) <= 2)
              );
            });
          return matches.length === 1;
        });
      };
      const proved = episodeRows.filter((e) => membership(e));
      const leftovers = episodeRows.filter((e) => !membership(e));
      // Legacy airtime writes occasionally shifted a handful of dates by two days.
      // Permit that only inside an otherwise >=95% proved full graph, for unique,
      // informative titles at the same official coordinates and compatible runtime.
      if (proved.length >= 10 && proved.length / episodeRows.length >= 0.95) {
        for (const e of leftovers) {
          const title = norm(e.title);
          const uniqueTitle = [options.snapshot, options.foreignSnapshot].some(
            (snapshot) =>
              snapshot?.flatMap((s) => s.episodes).filter((p) => norm(p.title) === title).length ===
              1,
          );
          if (
            !e.externalIds.length &&
            title.length >= 8 &&
            !/^(episode|part|pilot|tba|unknown)( |$)/.test(title) &&
            uniqueTitle &&
            membership(e, 72 * 60 * 60 * 1000)
          )
            legacyDateDriftIds.add(e.id);
        }
      }
      if (options.independentParentAnchor) {
        for (const e of leftovers) {
          const title = norm(e.title);
          const uniqueTitle = [options.snapshot, options.foreignSnapshot].some(
            (snapshot) =>
              snapshot?.flatMap((s) => s.episodes).filter((p) => norm(p.title) === title).length ===
              1,
          );
          if (
            !e.externalIds.length &&
            title.length >= 8 &&
            !/^(episode|part|pilot|tba|unknown)( |$)/.test(title) &&
            uniqueTitle &&
            membership(e, 7 * 86400000, true)
          )
            legacyDateDriftIds.add(e.id);
        }
      }
      // An isolated bad date inside a virtually complete proven graph is repairable
      // only when BOTH providers independently agree on its unique title, position,
      // runtime and date. No aliases may contradict that proof.
      if (
        proved.length >= 50 &&
        proved.length / episodeRows.length >= 0.99 &&
        leftovers.length <= 2
      ) {
        for (const episode of leftovers) {
          if (
            episode.externalIds.length ||
            norm(episode.title).length < 4 ||
            /^(episode|part|pilot|tba|unknown)( |$)/.test(norm(episode.title))
          )
            continue;
          const matches = [options.snapshot, options.foreignSnapshot].map((snapshot) =>
            (snapshot ?? [])
              .flatMap((season) =>
                season.episodes.map((e) => ({ ...e, seasonNumber: season.number })),
              )
              .filter((e) => norm(e.title) === norm(episode.title)),
          );
          if (matches.some((rows) => rows.length !== 1)) continue;
          const [a, b] = matches.map((rows) => rows[0]);
          if (
            [a, b].every(
              (e) =>
                e.seasonNumber === episode.seasonNumber &&
                e.number === episode.number &&
                e.runtimeMinutes &&
                episode.runtimeMinutes &&
                Math.abs(e.runtimeMinutes - episode.runtimeMinutes) <= 2 &&
                e.airDate &&
                episode.airDate &&
                Math.abs(new Date(e.airDate).getTime() - episode.airDate.getTime()) <=
                  14 * 86400000,
            ) &&
            Math.abs(new Date(a.airDate!).getTime() - new Date(b.airDate!).getTime()) <=
              36 * 3600000
          ) {
            legacyDateDriftIds.add(episode.id);
            dualProviderDateTypoIds.add(episode.id);
          }
        }
      }
      // A verified parent can contain obsolete, ID-less placeholders. Keep those as
      // quarantined metadata only when no user data or provider review references them.
      if (options.independentParentAnchor && proved.length > 0) {
        for (const episode of leftovers) {
          if (
            !legacyDateDriftIds.has(episode.id) &&
            !episode.externalIds.length &&
            !(await this.hasEpisodeUserDataTx(this.prisma, episode.id))
          )
            unprotectedLegacyIds.add(episode.id);
        }
      }
      if (
        !episodeRows.length ||
        !expected.size ||
        leftovers.some((e) => !legacyDateDriftIds.has(e.id) && !unprotectedLegacyIds.has(e.id))
      ) {
        return {
          ...result,
          reason: 'stray-episode-membership-unproven',
          provenEpisodes: proved.length,
          totalEpisodes: episodeRows.length,
          unprovenEpisodes: leftovers
            .filter((e) => !legacyDateDriftIds.has(e.id))
            .slice(0, 25)
            .map((e) => ({
              id: e.id,
              title: e.title,
              season: e.seasonNumber,
              episode: e.number,
              airDate: e.airDate,
              externalIds: e.externalIds,
              canonicalSnapshotEpisodes: expected.size,
              foreignSnapshotEpisodes: foreignIds.size,
            })),
        };
      }
    }
    let pairs: EpisodePair[] = [];
    if (target && options.type === 'SHOW') {
      if (!this.snapshotMatches(target, options.canonical, options.snapshot)) {
        return { ...result, reason: 'split-target-needs-structure-refresh' };
      }
      const projection = await this.remap!.previewCrossMediaMapping(
        sourceId,
        target.id,
        options.canonical!,
        options.foreignSnapshot,
      );
      if (projection.unmappedProtected.some((id) => !legacyDateDriftIds.has(id)))
        return { ...result, reason: 'unmapped-protected-episodes' };
      const toRows = new Map(target.seasons.flatMap((s) => s.episodes).map((e) => [e.id, e]));
      for (const pair of projection.pairs)
        for (const targetId of pair.targetIds) {
          const from = episodeRows.find((e) => e.id === pair.sourceId),
            to = toRows.get(targetId);
          if (!from || !to) return { ...result, reason: 'episode-graph-changed' };
          if (unprotectedLegacyIds.has(from.id)) continue;
          pairs.push({ source: from, target: to });
        }
    }
    if (target && legacyDateDriftIds.size) {
      const targets = target.seasons
        .flatMap((s) => s.episodes)
        .filter((e) => e.structureState !== 'LEGACY_UNMAPPED');
      for (const id of legacyDateDriftIds) {
        if (pairs.some((p) => p.source.id === id)) continue;
        const source = episodeRows.find((e) => e.id === id)!;
        const matches = targets.filter(
          (e) =>
            e.seasonNumber === source.seasonNumber &&
            e.number === source.number &&
            norm(e.title) === norm(source.title) &&
            ((verifiedUndatedSpecialIds.has(source.id) && e.isSpecial && !e.airDate) ||
              (e.airDate &&
                source.airDate &&
                Math.abs(e.airDate.getTime() - source.airDate.getTime()) <=
                  (dualProviderDateTypoIds.has(source.id)
                    ? 14 * 86400000
                    : options.independentParentAnchor
                      ? 7 * 86400000
                      : 72 * 60 * 60 * 1000))),
        );
        if (matches.length !== 1) return { ...result, reason: 'legacy-date-drift-target-unproven' };
        pairs.push({ source, target: matches[0] });
      }
    }
    if (options.mode === 'dry-run')
      return {
        ...result,
        status: 'ready',
        reason: 'verified-typed-split',
        legacyDateDriftMappings: legacyDateDriftIds.size,
        quarantinedMetadataRows: unprotectedLegacyIds.size,
        episodeMappings:
          options.type === 'SHOW'
            ? episodeRows.map((e) => ({
                sourceMediaId: sourceId,
                sourceEpisodeId: e.id,
                targetMediaId: result.targetMediaId,
                targetEpisodeIds: target
                  ? pairs.filter((p) => p.source.id === e.id).map((p) => p.target.id)
                  : [e.id],
                policy: unprotectedLegacyIds.has(e.id) ? 'quarantine' : target ? 'copy' : 'move',
                season: e.seasonNumber,
                episode: e.number,
              }))
            : [],
      };
    const prepare = async (tx: Prisma.TransactionClient) => {
      const live = await tx.mediaItem.findUniqueOrThrow({ where: { id: sourceId } });
      for (const id of unprotectedLegacyIds) {
        if (await this.hasEpisodeUserDataTx(tx, id))
          throw new Error('An unproven episode acquired protected data');
      }
      if (unprotectedLegacyIds.size)
        await tx.episode.updateMany({
          where: { id: { in: [...unprotectedLegacyIds] } },
          data: { structureState: 'LEGACY_UNMAPPED' },
        });
      const voteWhere: Prisma.CharacterVoteWhereInput =
        options.type === 'SHOW'
          ? { episode: { season: { show: { mediaId: sourceId } } } }
          : { mediaId: sourceId, episodeId: null };
      const votes = await tx.characterVote.findMany({ where: voteWhere });
      if (votes.some((v) => !options.allowedCastIds.includes(v.castId)))
        throw new Error('Split has an unproven character vote');
      const container = await tx.mediaItem.create({
        data: {
          id: splitId,
          type: options.type,
          title: options.title,
          metadataProvenance: {
            identitySplitSource: sourceId,
            evidence: options.evidence ?? {},
            originalAliases: original.externalIds,
            at: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });
      const containerId = container.id;
      if (options.type === 'SHOW') {
        await tx.show.update({ where: { mediaId: sourceId }, data: { mediaId: containerId } });
        await tx.userShowStatus.updateMany({
          where: { mediaId: sourceId },
          data: { mediaId: containerId },
        });
        if (!target && unprotectedLegacyIds.size) {
          await this.recomputeShowInventory(tx, containerId);
          const users = await tx.userShowStatus.findMany({
            where: { mediaId: containerId },
            select: { userId: true },
          });
          await this.recomputeShowStatuses(
            tx,
            containerId,
            new Set(users.map((user) => user.userId)),
          );
        }
      } else {
        await tx.movie.update({ where: { mediaId: sourceId }, data: { mediaId: containerId } });
        await tx.userMovieStatus.updateMany({
          where: { mediaId: sourceId },
          data: { mediaId: containerId },
        });
      }
      await tx.watchHistory.updateMany({
        where:
          options.type === 'SHOW'
            ? {
                OR: [
                  { mediaId: sourceId, mediaType: 'SHOW' },
                  { episodeId: { in: episodeRows.map((e) => e.id) } },
                ],
              }
            : { mediaId: sourceId, mediaType: 'MOVIE', episodeId: null },
        data: { mediaId: containerId, mediaType: options.type },
      });
      await tx.comment.updateMany({
        where: { threadType: options.type, threadId: sourceId },
        data: { threadId: containerId },
      });
      await tx.comment.updateMany({
        where: { mediaType: options.type, mediaId: sourceId },
        data: { mediaId: containerId },
      });
      for (const vote of votes) {
        const castId = await this.ensureTargetCast(tx, vote.castId, containerId);
        await tx.characterVote.update({
          where: { id: vote.id },
          data: {
            castId,
            ...(options.type === 'MOVIE' ? { mediaId: containerId } : {}),
          },
        });
      }
      for (const identity of options.verifiedIds) {
        const typed = identity as {
          provider: ExternalProvider;
          providerEntityKind: ProviderEntityKind;
          value: string;
        };
        const existing = await tx.externalId.findUnique({
          where: { provider_providerEntityKind_value: typed },
        });
        if (existing && ![sourceId, target?.id, containerId].includes(existing.mediaId)) {
          throw new Error('Split alias acquired by another owner');
        }
        if (!existing)
          await tx.externalId.create({ data: { ...typed, mediaId: target?.id ?? containerId } });
        else if (existing.mediaId === sourceId)
          await tx.externalId.update({
            where: { id: existing.id },
            data: { mediaId: target?.id ?? containerId },
          });
      }
      // These exact aliases were separately proved to have the wrong declared namespace.
      if (options.removeAliasIds.length)
        await tx.externalId.deleteMany({
          where: { id: { in: options.removeAliasIds }, mediaId: sourceId },
        });
      const provenance =
        live.metadataProvenance && typeof live.metadataProvenance === 'object'
          ? (live.metadataProvenance as Record<string, unknown>)
          : {};
      await tx.mediaItem.update({
        where: { id: sourceId },
        data: {
          metadataRefreshedAt: null,
          titles: Prisma.DbNull,
          overviews: Prisma.DbNull,
          posterUrls: Prisma.DbNull,
          backdropUrls: Prisma.DbNull,
          galleryState: Prisma.DbNull,
          metadataProvenance: {
            ...provenance,
            identitySplit: {
              targets: { [options.type]: target?.id ?? containerId },
              sourceAliases: original.externalIds,
              at: new Date().toISOString(),
              fingerprint,
              retained: result.retained,
              evidence: options.evidence ?? {},
            },
          } as Prisma.InputJsonValue,
        },
      });
    };
    if (target) {
      const source: ShowGraph = {
        ...original,
        id: splitId,
        type: options.type,
        hasOppositeStructure: false,
        title: options.title,
        externalIds: options.verifiedIds as ShowGraph['externalIds'],
        seasons: options.type === 'SHOW' ? original.seasons : [],
      };
      await this.consolidatePlan(
        [
          {
            source,
            target,
            match: {
              relation: MediaCanonicalRelation.EXACT_DUPLICATE,
              targetSeasonNumber: null,
              pairs,
            },
          },
        ],
        {
          ...options.evidence,
          identityFingerprint: fingerprint,
          identityMembers: graphs.map((g) => g.id),
          lockMediaIds: [sourceId],
          verifiedIds: options.verifiedIds,
        },
        prepare,
        options.commit,
      );
    } else {
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM media_items WHERE id = ${sourceId} FOR UPDATE`,
          );
          const current = await this.loadGraph(sourceId, tx);
          if (!current || this.graphFingerprint([current]) !== fingerprint)
            throw new Error('Identity plan changed before apply');
          const manifest = await new IdentityTransferManifest(tx as PrismaService).summary({
            action: 'split',
            mediaId: sourceId,
            targetMediaId: result.targetMediaId,
            splitOptions: { type: options.type },
          });
          if (manifest.blocked)
            throw new Error('Protected source data changed or an image is still processing');
          await prepare(tx);
          await options.commit?.(tx);
        },
        { timeout: 120000, maxWait: 30000 },
      );
      // Existing events invalidate derived user statistics after the typed ownership move.
      const users = await this.prisma.watchHistory.findMany({
        where: { mediaId: splitId },
        select: { userId: true },
        distinct: ['userId'],
      });
      for (const { userId } of users) {
        await Promise.all([
          this.redis.delByPattern(`watchnext:${userId}:*`),
          this.redis.delByPattern(`upcoming:${userId}:*`),
          markPersonalizationDirty(this.redis, userId),
        ]);
        this.events.emit('import.applied', { userId });
      }
    }
    return { ...result, status: 'applied', reason: 'verified-typed-split' };
  }

  private snapshotMatches(
    graph: ShowGraph,
    canonical?: 'tmdb' | 'tvdb',
    snapshot?: NormalizedSeason[],
  ) {
    if (!canonical || !snapshot?.length) return false;
    const provider = canonical === 'tvdb' ? ExternalProvider.THE_TVDB : ExternalProvider.TMDB;
    const expected = snapshot
      .filter((s) => !s.isSpecial && s.number > 0)
      .flatMap((s) => s.episodes.map((e) => ({ season: s.number, episode: e })));
    const active = graph.seasons
      .filter((s) => !s.isSpecial)
      .flatMap((s) => s.episodes)
      .filter((e) => e.structureState !== 'LEGACY_UNMAPPED');
    if (!expected.length || expected.length !== active.length) return false;
    const used = new Set<string>();
    return expected.every(({ season, episode }) => {
      const candidates = active.filter(
        (e) =>
          !used.has(e.id) &&
          (e.externalIds.some(
            (id) => id.provider === provider && id.value === String(episode.tmdbId),
          ) ||
            (e.seasonNumber === season &&
              e.number === episode.number &&
              !!e.airDate &&
              !!episode.airDate &&
              e.airDate.toISOString().slice(0, 10) === String(episode.airDate).slice(0, 10) &&
              !!norm(e.title) &&
              norm(e.title) === norm(episode.title))),
      );
      if (candidates.length !== 1) return false;
      used.add(candidates[0].id);
      return true;
    });
  }

  private transferMappings(plans: CanonicalPlan[]) {
    return plans.flatMap((plan) => {
      const mappings = new Map<string, string[]>();
      for (const pair of plan.match.pairs)
        mappings.set(pair.source.id, [...(mappings.get(pair.source.id) ?? []), pair.target.id]);
      return plan.source.seasons
        .flatMap((s) => s.episodes)
        .map((e) => ({
          sourceMediaId: plan.source.id,
          sourceEpisodeId: e.id,
          targetMediaId: plan.target.id,
          targetEpisodeIds: [...new Set(mappings.get(e.id) ?? [])],
          policy: mappings.has(e.id)
            ? 'copy'
            : e.isSpecial
              ? 'preserve-special'
              : 'unmapped-unprotected',
          season: e.seasonNumber,
          episode: e.number,
        }));
    });
  }

  private async loadGraph(
    mediaId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<ShowGraph | null> {
    const row = await db.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        type: true,
        movie: { select: { id: true } },
        title: true,
        normalizedTitle: true,
        externalIds: { select: { provider: true, providerEntityKind: true, value: true } },
        show: {
          select: {
            structureProvider: true,
            structureReason: true,
            seasons: {
              orderBy: { number: 'asc' },
              select: {
                number: true,
                isSpecial: true,
                episodes: {
                  where: { structureState: { in: ['ACTIVE', 'LEGACY_UNMAPPED'] } },
                  orderBy: { number: 'asc' },
                  select: {
                    id: true,
                    structureState: true,
                    number: true,
                    title: true,
                    airDate: true,
                    runtimeMinutes: true,
                    externalIds: { select: { provider: true, value: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      hasOppositeStructure: row.type === 'MOVIE' ? !!row.show : !!row.movie,
      title: row.title,
      normalizedTitle: row.normalizedTitle,
      structureProvider: row.show?.structureProvider ?? null,
      structureReason: row.show?.structureReason ?? null,
      externalIds: row.externalIds,
      seasons: (row.show?.seasons ?? []).map((season) => ({
        number: season.number,
        isSpecial: season.isSpecial,
        episodes: season.episodes.map((episode) => ({
          ...episode,
          seasonNumber: season.number,
          isSpecial: season.isSpecial,
        })),
      })),
    };
  }

  private externalId(graph: ShowGraph, provider: ExternalProvider): string | null {
    return graph.externalIds.find((row) => row.provider === provider)?.value ?? null;
  }

  private matchGraph(source: ShowGraph, target: ShowGraph): GraphMatch | null {
    const regular = (graph: ShowGraph) =>
      graph.seasons
        .filter((season) => !season.isSpecial)
        .map((season) => ({
          ...season,
          episodes: season.episodes.filter(
            (episode) => episode.structureState !== 'LEGACY_UNMAPPED',
          ),
        }))
        .filter((season) => season.episodes.length);
    const sourceRegular = regular(source);
    const targetRegular = regular(target);
    if (sourceRegular.length === 0 || targetRegular.length === 0) return null;

    let relation: MediaCanonicalRelation;
    let targetSeasonNumber: number | null = null;
    let regularPairs: EpisodePair[] = [];
    if (
      sourceRegular.length === targetRegular.length &&
      sourceRegular.every((season, index) => season.number === targetRegular[index]?.number)
    ) {
      relation = MediaCanonicalRelation.EXACT_DUPLICATE;
      for (let index = 0; index < sourceRegular.length; index++) {
        const pairs = this.matchSeason(sourceRegular[index], targetRegular[index]);
        if (!pairs) return null;
        regularPairs.push(...pairs);
      }
    } else if (sourceRegular.length === 1) {
      const matching = targetRegular
        .map((season) => ({ season, pairs: this.matchSeason(sourceRegular[0], season) }))
        .filter((row): row is { season: GraphSeason; pairs: EpisodePair[] } => !!row.pairs);
      if (matching.length !== 1) return null;
      relation = MediaCanonicalRelation.SEASON_COMPONENT;
      targetSeasonNumber = matching[0].season.number;
      regularPairs = matching[0].pairs;
    } else {
      return null;
    }

    const targetSpecials = target.seasons
      .filter((season) => season.isSpecial)
      .flatMap((season) => season.episodes);
    const specialPairs: EpisodePair[] = [];
    for (const sourceEpisode of source.seasons
      .filter((season) => season.isSpecial)
      .flatMap((season) => season.episodes)) {
      const matches = targetSpecials.filter((targetEpisode) =>
        episodeEquivalent(sourceEpisode, targetEpisode),
      );
      if (matches.length === 1) specialPairs.push({ source: sourceEpisode, target: matches[0] });
    }
    return { relation, targetSeasonNumber, pairs: [...regularPairs, ...specialPairs] };
  }

  private matchSeason(source: GraphSeason, target: GraphSeason): EpisodePair[] | null {
    if (source.episodes.length === 0 || source.episodes.length !== target.episodes.length)
      return null;
    const pairs: EpisodePair[] = [];
    for (let index = 0; index < source.episodes.length; index++) {
      const sourceEpisode = source.episodes[index];
      const targetEpisode = target.episodes[index];
      if (!episodeEquivalent(sourceEpisode, targetEpisode)) return null;
      pairs.push({ source: sourceEpisode, target: targetEpisode });
    }
    return pairs;
  }

  private async verifyComponentIdentity(
    source: ShowGraph,
    match: GraphMatch,
    episodeFindCache = new Map<string, any>(),
  ): Promise<boolean> {
    const tmdbId = Number(this.externalId(source, ExternalProvider.TMDB));
    if (!Number.isSafeInteger(tmdbId) || tmdbId <= 0) return false;
    for (const pair of match.pairs.filter((row) => !row.source.isSpecial)) {
      const tvdbEpisodeId = pair.target.externalIds.find(
        (external) => external.provider === ExternalProvider.THE_TVDB,
      )?.value;
      if (!tvdbEpisodeId) return false;
      let found = episodeFindCache.get(tvdbEpisodeId);
      if (!episodeFindCache.has(tvdbEpisodeId)) {
        found = await this.tmdb.findByExternalIdStrict(tvdbEpisodeId, 'tvdb_id');
        episodeFindCache.set(tvdbEpisodeId, found);
      }
      if (
        !found?.episode ||
        found.episode.showId !== tmdbId ||
        found.episode.season !== pair.source.seasonNumber ||
        found.episode.episode !== pair.source.number
      ) {
        return false;
      }
    }
    return true;
  }

  /**
   * Copy and activate a complete identity plan in ONE database transaction. A plan can
   * contain the TVDB aggregate, an exact TMDB duplicate, and several TMDB season shows.
   * No source redirect becomes active unless every source row has copied and verified.
   */
  private async consolidatePlan(
    plans: CanonicalPlan[],
    evidence: Record<string, unknown>,
    prepare?: (tx: Prisma.TransactionClient) => Promise<void>,
    commit?: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<number> {
    const uniquePlans = [...new Map(plans.map((plan) => [plan.source.id, plan])).values()].filter(
      (plan) => plan.source.id !== plan.target.id,
    );
    if (uniquePlans.length === 0) return 0;
    const targetIds = new Set(uniquePlans.map((plan) => plan.target.id));
    if (targetIds.size !== 1) throw new Error('canonical plan must converge on exactly one target');
    const targetMediaId = [...targetIds][0];
    const targetSourceLink = await this.prisma.mediaCanonicalLink.findUnique({
      where: { sourceMediaId: targetMediaId },
      select: { targetMediaId: true, status: true },
    });
    if (targetSourceLink && targetSourceLink.status !== MediaCanonicalStatus.FAILED) {
      throw new Error(
        `canonical target ${targetMediaId} is already a ${targetSourceLink.status} source for ${targetSourceLink.targetMediaId}`,
      );
    }

    const existingLinks = await this.prisma.mediaCanonicalLink.findMany({
      where: { sourceMediaId: { in: uniquePlans.map((plan) => plan.source.id) } },
      select: { sourceMediaId: true, targetMediaId: true, status: true },
    });
    const existingBySource = new Map(existingLinks.map((link) => [link.sourceMediaId, link]));
    for (const plan of uniquePlans) {
      const existing = existingBySource.get(plan.source.id);
      if (
        existing?.status === MediaCanonicalStatus.ACTIVE &&
        existing.targetMediaId !== plan.target.id
      ) {
        throw new Error(`source ${plan.source.id} already points at another canonical media`);
      }
    }
    const actionable = uniquePlans.filter(
      (plan) => existingBySource.get(plan.source.id)?.status !== MediaCanonicalStatus.ACTIVE,
    );
    if (actionable.length === 0) return 0;

    try {
      // Preflight the complete plan before opening the long transaction. External reviews
      // count as user-visible data too; an unproven episode may never be hidden with any of
      // these rows attached.
      for (const plan of actionable) {
        if (
          plan.source.structureReason === 'MANUAL_OVERRIDE' &&
          (plan.target.structureReason !== 'MANUAL_OVERRIDE' ||
            plan.source.structureProvider !== plan.target.structureProvider)
        ) {
          throw new Error('Manual structure authority must be preserved');
        }
        const mappedIds = new Set(plan.match.pairs.map((pair) => pair.source.id));
        const unmappedRegular = plan.source.seasons
          .flatMap((season) => season.episodes)
          .filter((episode) => !episode.isSpecial && !mappedIds.has(episode.id));
        if (
          unmappedRegular.length > 0 &&
          (await this.hasEpisodeUserData(unmappedRegular.map((episode) => episode.id)))
        ) {
          throw new Error(
            `${plan.source.id}: ${unmappedRegular.length} regular source episode(s) with user data have no proven target`,
          );
        }
      }

      const report = await this.prisma.$transaction(
        async (tx) => {
          // Lock all source/target media in stable order. Concurrent evaluations of the
          // same canonical family serialize here and re-check ACTIVE links under the lock.
          const lockIds = [
            ...new Set([
              ...actionable.flatMap((plan) => [plan.source.id, plan.target.id]),
              ...(Array.isArray(evidence.lockMediaIds) ? (evidence.lockMediaIds as string[]) : []),
            ]),
          ].sort();
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM media_items WHERE id IN (${Prisma.join(
              lockIds,
            )}) ORDER BY id FOR UPDATE`,
          );

          if (
            typeof evidence.identityFingerprint === 'string' &&
            Array.isArray(evidence.identityMembers)
          ) {
            const current = (
              await Promise.all(
                (evidence.identityMembers as string[]).map((id) => this.loadGraph(id, tx)),
              )
            ).filter((g): g is ShowGraph => !!g);
            if (this.graphFingerprint(current) !== evidence.identityFingerprint) {
              throw new Error('Identity plan changed before apply');
            }
          }
          if (prepare) await prepare(tx);
          const transactionPlans: Array<
            CanonicalPlan & { linkId: string; copyPairs: EpisodePair[] }
          > = [];
          for (const plan of actionable) {
            const current = await tx.mediaCanonicalLink.findUnique({
              where: { sourceMediaId: plan.source.id },
              select: { targetMediaId: true, status: true },
            });
            if (current?.status === MediaCanonicalStatus.ACTIVE) {
              if (current.targetMediaId !== plan.target.id) {
                throw new Error(
                  `source ${plan.source.id} became active on another canonical target`,
                );
              }
              continue;
            }
            const link = await tx.mediaCanonicalLink.upsert({
              where: { sourceMediaId: plan.source.id },
              create: {
                sourceMediaId: plan.source.id,
                targetMediaId: plan.target.id,
                relation: plan.match.relation,
                targetSeasonNumber: plan.match.targetSeasonNumber,
                status: MediaCanonicalStatus.COPYING,
                evidence: {
                  ...evidence,
                  sourceExternals: plan.source.externalIds,
                } as Prisma.InputJsonValue,
              },
              update: {
                targetMediaId: plan.target.id,
                relation: plan.match.relation,
                targetSeasonNumber: plan.match.targetSeasonNumber,
                status: MediaCanonicalStatus.COPYING,
                evidence: {
                  ...evidence,
                  sourceExternals: plan.source.externalIds,
                } as Prisma.InputJsonValue,
                lastError: null,
                activatedAt: null,
              },
              select: { id: true },
            });
            const supplementalPairs =
              plan.source.type === 'MOVIE'
                ? []
                : await this.ensureSupplementalSpecialPairs(tx, plan);
            transactionPlans.push({
              ...plan,
              linkId: link.id,
              copyPairs: [...plan.match.pairs, ...supplementalPairs],
            });
          }
          if (transactionPlans.length === 0) {
            return { activated: 0, rows: 0, affectedUserIds: [] as string[] };
          }

          for (const plan of transactionPlans) {
            const manifest = await new IdentityTransferManifest(tx as PrismaService).summary({
              action: 'consolidate',
              mediaId: plan.source.id,
              targetMediaId: plan.target.id,
              members: [plan.source.id, plan.target.id],
              details: { sourceMediaIds: [plan.source.id] },
            });
            if (manifest.blocked)
              throw new Error('Protected source data changed or an image is still processing');
          }

          // Revalidate that every exact episode endpoint still exists and is active inside
          // the cutover transaction. A concurrent structure rewrite therefore fails the
          // entire family instead of activating stale ledgers.
          const episodeIds = [
            ...new Set(
              transactionPlans.flatMap((plan) =>
                plan.copyPairs.flatMap((pair) => [pair.source.id, pair.target.id]),
              ),
            ),
          ];
          const sourceEpisodeIds = [
            ...new Set(
              transactionPlans.flatMap((plan) => plan.copyPairs.map((pair) => pair.source.id)),
            ),
          ];
          const targetEpisodeIds = [
            ...new Set(
              transactionPlans.flatMap((plan) => plan.copyPairs.map((pair) => pair.target.id)),
            ),
          ];
          const activeEpisodeCount = await tx.episode.count({
            where: {
              OR: [
                {
                  id: { in: sourceEpisodeIds },
                  structureState: { in: ['ACTIVE', 'LEGACY_UNMAPPED'] },
                },
                { id: { in: targetEpisodeIds }, structureState: 'ACTIVE' },
              ],
            },
          });
          if (activeEpisodeCount !== episodeIds.length) {
            throw new Error(
              `structure changed during canonicalization (${activeEpisodeCount}/${episodeIds.length} active episode endpoints)`,
            );
          }

          const affectedUsers = new Set<string>();
          for (const plan of transactionPlans) {
            const copiedSources = new Set<string>();
            for (const pair of plan.copyPairs) {
              await this.copyEpisode(
                tx,
                plan.linkId,
                plan.source.id,
                plan.target.id,
                pair,
                affectedUsers,
                copiedSources.has(pair.source.id) ? `:split:${pair.target.id}` : '',
              );
              copiedSources.add(pair.source.id);
            }
            await this.copyMediaData(
              tx,
              plan.linkId,
              plan.source.id,
              plan.target.id,
              affectedUsers,
              plan.source.type ?? 'SHOW',
            );
          }
          for (const targetMediaId of new Set(
            transactionPlans
              .filter((plan) => plan.target.type !== 'MOVIE')
              .map((plan) => plan.target.id),
          )) {
            await this.seedCanonicalRecommendations(
              tx,
              targetMediaId,
              transactionPlans
                .filter((plan) => plan.target.id === targetMediaId)
                .map((plan) => plan.source.id),
            );
            await this.recomputeShowInventory(tx, targetMediaId);
            await this.recomputeShowStatuses(tx, targetMediaId, affectedUsers);
          }

          const verifiedPlans: Array<{
            linkId: string;
            report: { rows: number; byType: Record<string, number> };
          }> = [];
          for (const plan of transactionPlans) {
            const verified = await this.verifyCopy(
              tx,
              plan.linkId,
              plan.source.id,
              [...new Set(plan.copyPairs.map((pair) => pair.source.id))],
              plan.source.type ?? 'SHOW',
              plan.copyPairs.filter(
                (pair, index, pairs) =>
                  pairs.findIndex((p) => p.source.id === pair.source.id) !== index,
              ),
            );
            verifiedPlans.push({ linkId: plan.linkId, report: verified });
          }

          // For an exact verified family, make accepted core aliases belong to the
          // canonical row. Component-family aliases stay on their retained sources.
          if (Array.isArray(evidence.verifiedIds)) {
            for (const plan of transactionPlans) {
              const owned = await tx.externalId.findMany({ where: { mediaId: plan.target.id } });
              for (const alias of evidence.verifiedIds as any[]) {
                if (
                  owned.some(
                    (id) =>
                      id.provider === alias.provider &&
                      id.providerEntityKind === alias.providerEntityKind,
                  )
                )
                  continue;
                const moved = await tx.externalId.updateMany({
                  where: { mediaId: plan.source.id, ...alias },
                  data: { mediaId: plan.target.id },
                });
                if (moved.count) owned.push({ ...alias, mediaId: plan.target.id } as any);
              }
            }
          }

          // Move exact one-to-one episode aliases; combined-broadcast aliases remain
          // on the retained source, where the copy ledger preserves their full mapping.
          if (Array.isArray(evidence.verifiedIds))
            for (const plan of transactionPlans) {
              const bySource = new Map<string, Set<string>>();
              for (const pair of plan.copyPairs) {
                const targets = bySource.get(pair.source.id) ?? new Set<string>();
                targets.add(pair.target.id);
                bySource.set(pair.source.id, targets);
              }
              for (const [episodeId, targets] of bySource) {
                const aliases = await tx.episodeExternalId.findMany({ where: { episodeId } });
                await recordEpisodeRemap(tx, episodeId, [...targets], aliases, 1, false);
                if (targets.size === 1) {
                  const targetId = [...targets][0];
                  const owned = await tx.episodeExternalId.findMany({
                    where: { episodeId: targetId },
                  });
                  for (const alias of aliases) {
                    if (owned.some((id) => id.provider === alias.provider)) continue;
                    await tx.episodeExternalId.updateMany({
                      where: { id: alias.id },
                      data: { episodeId: targetId },
                    });
                    owned.push(alias);
                  }
                }
              }
            }

          if (Array.isArray(evidence.verifiedIds)) {
            for (const mediaId of new Set(transactionPlans.map((plan) => plan.target.id))) {
              await tx.$executeRaw`UPDATE media_items
                SET metadata_provenance=(COALESCE(metadata_provenance,'{}'::jsonb)
                  - 'animeTvdbNoId' - 'tvdbIdentityCollision' - 'recsCheckedAt' - 'charIdsCheckedAt'
                  - 'countryCheckedAt' - 'bannerCheckedAt' - 'hydrateNotFoundAt' - 'ratingCheckedAt'
                  - 'enContentRepairFailedAt' - 'enContentRepairFailedReason'
                  - 'castDedupCheckedAt' - 'structureBackfill'),
                  metadata_refreshed_at=NULL WHERE id=${mediaId}`;
            }
          }

          // This loop is intentionally last. All links become ACTIVE in the same commit,
          // after all copies and every per-source ledger count have passed.
          const activatedAt = new Date();
          await tx.$executeRaw(
            Prisma.sql`UPDATE media_items SET updated_at=clock_timestamp() WHERE id IN (${Prisma.join(lockIds)})`,
          );
          for (const verified of verifiedPlans) {
            await tx.mediaCanonicalLink.update({
              where: { id: verified.linkId },
              data: {
                status: MediaCanonicalStatus.ACTIVE,
                activatedAt,
                lastError: null,
                copyReport: verified.report as Prisma.InputJsonValue,
              },
            });
          }
          await commit?.(tx);
          return {
            activated: verifiedPlans.length,
            rows: verifiedPlans.reduce((sum, verified) => sum + verified.report.rows, 0),
            affectedUserIds: [...affectedUsers],
          };
        },
        // Sources remain visible until commit, so a heavily-used family can safely take a
        // long background transaction without exposing a partially copied target.
        { timeout: 600_000, maxWait: 30_000 },
      );

      this.logger.log(
        `canonicalized atomic plan (${report.activated} links, ${report.rows} user rows verified)`,
      );
      for (const userId of report.affectedUserIds) {
        await Promise.all([
          this.redis.delByPattern(`watchnext:${userId}:*`),
          this.redis.delByPattern(`upcoming:${userId}:*`),
          this.redis.delByPattern(`showsprogress:${userId}:*`),
          markPersonalizationDirty(this.redis, userId),
          this.redis.del(`watchnext:${userId}`),
          this.redis.del(`upcoming:${userId}`),
        ]).catch(() => undefined);
        this.events.emit('import.applied', { userId });
      }
      return report.activated;
    } catch (error) {
      if (!prepare) await this.recordPlanFailure(actionable, evidence, error);
      throw error;
    }
  }

  private async recordPlanFailure(
    plans: CanonicalPlan[],
    evidence: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    const lastError = error instanceof Error ? error.message : String(error);
    for (const plan of plans) {
      const updated = await this.prisma.mediaCanonicalLink
        .updateMany({
          where: {
            sourceMediaId: plan.source.id,
            status: { not: MediaCanonicalStatus.ACTIVE },
          },
          data: {
            targetMediaId: plan.target.id,
            relation: plan.match.relation,
            targetSeasonNumber: plan.match.targetSeasonNumber,
            status: MediaCanonicalStatus.FAILED,
            evidence: evidence as Prisma.InputJsonValue,
            lastError,
            activatedAt: null,
          },
        })
        .catch(() => ({ count: 0 }));
      if (updated.count > 0) continue;
      const existing = await this.prisma.mediaCanonicalLink
        .findUnique({ where: { sourceMediaId: plan.source.id }, select: { id: true } })
        .catch(() => null);
      if (existing) continue;
      await this.prisma.mediaCanonicalLink
        .create({
          data: {
            sourceMediaId: plan.source.id,
            targetMediaId: plan.target.id,
            relation: plan.match.relation,
            targetSeasonNumber: plan.match.targetSeasonNumber,
            status: MediaCanonicalStatus.FAILED,
            evidence: evidence as Prisma.InputJsonValue,
            lastError,
          },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Specials do not participate in regular structure authority. If an unmatched source
   * special already carries user data, preserve it under the canonical show as an ACTIVE,
   * non-authoritative supplement. The target deliberately receives no provider alias: the
   * immutable canonical-copy ledger owns the old episode redirect, while the source row and
   * its provider identity remain retained as recovery evidence.
   */
  private async ensureSupplementalSpecialPairs(
    tx: Prisma.TransactionClient,
    plan: CanonicalPlan,
  ): Promise<EpisodePair[]> {
    const mappedSourceIds = new Set(plan.match.pairs.map((pair) => pair.source.id));
    const unmatchedSpecials = plan.source.seasons
      .flatMap((season) => season.episodes)
      .filter((episode) => episode.isSpecial && !mappedSourceIds.has(episode.id));
    if (unmatchedSpecials.length === 0) return [];

    const protectedSpecials: GraphEpisode[] = [];
    for (const special of unmatchedSpecials) {
      if (await this.hasEpisodeUserDataTx(tx, special.id)) protectedSpecials.push(special);
    }
    if (protectedSpecials.length === 0) return [];

    const targetShow = await tx.show.findUnique({
      where: { mediaId: plan.target.id },
      select: { id: true },
    });
    if (!targetShow) throw new Error(`canonical target ${plan.target.id} has no show row`);
    const targetSeason = await tx.season.upsert({
      where: { showId_number: { showId: targetShow.id, number: 0 } },
      create: {
        showId: targetShow.id,
        number: 0,
        title: 'Specials',
        isSpecial: true,
      },
      update: { isSpecial: true },
      select: { id: true },
    });

    const pairs: EpisodePair[] = [];
    for (const special of protectedSpecials) {
      const source = await tx.episode.findUnique({
        where: { id: special.id },
        select: {
          id: true,
          number: true,
          absoluteNumber: true,
          title: true,
          overview: true,
          stillUrl: true,
          runtimeMinutes: true,
          airDate: true,
          airTime: true,
          rating: true,
          isFinale: true,
          titles: true,
          overviews: true,
          stillUrls: true,
        },
      });
      if (!source) throw new Error(`source special ${special.id} disappeared`);

      const candidates = await tx.episode.findMany({
        where: { seasonId: targetSeason.id, structureState: 'ACTIVE' },
        select: {
          id: true,
          number: true,
          title: true,
          airDate: true,
          runtimeMinutes: true,
        },
      });
      const matching = candidates.filter((candidate) =>
        episodeEquivalent(special, {
          ...candidate,
          seasonNumber: 0,
          isSpecial: true,
          externalIds: [],
        }),
      );
      if (matching.length > 1) {
        throw new Error(
          `${special.id}: multiple canonical specials match ${special.title} (${day(special.airDate)})`,
        );
      }

      const target =
        matching[0] ??
        (await tx.episode.create({
          data: {
            seasonId: targetSeason.id,
            number: source.number,
            absoluteNumber: source.absoluteNumber,
            title: source.title,
            overview: source.overview,
            stillUrl: source.stillUrl,
            runtimeMinutes: source.runtimeMinutes,
            airDate: source.airDate,
            airTime: source.airTime,
            rating: source.rating,
            isFinale: source.isFinale,
            structureState: 'ACTIVE',
            titles:
              source.titles === null ? Prisma.JsonNull : (source.titles as Prisma.InputJsonValue),
            overviews:
              source.overviews === null
                ? Prisma.JsonNull
                : (source.overviews as Prisma.InputJsonValue),
            stillUrls:
              source.stillUrls === null
                ? Prisma.JsonNull
                : (source.stillUrls as Prisma.InputJsonValue),
          },
          select: {
            id: true,
            number: true,
            title: true,
            airDate: true,
            runtimeMinutes: true,
          },
        }));
      pairs.push({
        source: special,
        target: {
          ...target,
          seasonNumber: 0,
          isSpecial: true,
          externalIds: [],
        },
      });
    }

    const now = new Date();
    const [episodeCount, airedCount] = await Promise.all([
      tx.episode.count({
        where: { seasonId: targetSeason.id, structureState: 'ACTIVE' },
      }),
      tx.episode.count({
        where: {
          seasonId: targetSeason.id,
          structureState: 'ACTIVE',
          ...episodeAiredWhere(now),
        },
      }),
    ]);
    await tx.season.update({
      where: { id: targetSeason.id },
      data: { episodeCount, airedCount },
    });
    return pairs;
  }

  private async hasEpisodeUserDataTx(
    tx: Prisma.TransactionClient,
    episodeId: string,
  ): Promise<boolean> {
    const [statuses, histories, ratings, reactions, votes, comments, externalReviews] =
      await Promise.all([
        tx.userEpisodeStatus.count({ where: { episodeId } }),
        tx.watchHistory.count({ where: { episodeId } }),
        tx.rating.count({ where: { episodeId } }),
        tx.reaction.count({ where: { episodeId } }),
        tx.characterVote.count({ where: { episodeId } }),
        tx.comment.count({
          where: { threadType: CommentThreadType.EPISODE, threadId: episodeId },
        }),
        tx.externalReview.count({ where: { episodeId } }),
      ]);
    return statuses + histories + ratings + reactions + votes + comments + externalReviews > 0;
  }

  private async hasEpisodeUserData(episodeIds: string[]): Promise<boolean> {
    if (episodeIds.length === 0) return false;
    const [statuses, histories, ratings, reactions, votes, comments, externalReviews] =
      await Promise.all([
        this.prisma.userEpisodeStatus.count({ where: { episodeId: { in: episodeIds } } }),
        this.prisma.watchHistory.count({ where: { episodeId: { in: episodeIds } } }),
        this.prisma.rating.count({ where: { episodeId: { in: episodeIds } } }),
        this.prisma.reaction.count({ where: { episodeId: { in: episodeIds } } }),
        this.prisma.characterVote.count({ where: { episodeId: { in: episodeIds } } }),
        this.prisma.comment.count({
          where: { threadType: CommentThreadType.EPISODE, threadId: { in: episodeIds } },
        }),
        this.prisma.externalReview.count({ where: { episodeId: { in: episodeIds } } }),
      ]);
    return statuses + histories + ratings + reactions + votes + comments + externalReviews > 0;
  }

  /** Seed a TVDB canonical target from retained TMDB component recommendation snapshots. */
  private async seedCanonicalRecommendations(
    tx: Prisma.TransactionClient,
    targetMediaId: string,
    sourceMediaIds: string[],
  ): Promise<void> {
    const rows = await tx.mediaItem.findMany({
      where: { id: { in: [...new Set([targetMediaId, ...sourceMediaIds])] } },
      select: {
        id: true,
        recommendations: true,
        externalIds: {
          where: {
            provider: ExternalProvider.TMDB,
            providerEntityKind: ProviderEntityKind.SERIES,
          },
          select: { value: true },
        },
      },
    });
    const target = rows.find((row) => row.id === targetMediaId);
    // A target with its own TMDB series identity remains the metadata authority. Its
    // provider recommendations must never be replaced by component snapshots.
    if (target?.externalIds.length) return;
    const familyTmdbIds = new Set(
      rows
        .flatMap((row) => row.externalIds)
        .map((external) => Number(external.value))
        .filter((id) => Number.isSafeInteger(id) && id > 0),
    );
    const sourceRows = rows.filter(
      (row) =>
        row.id !== targetMediaId && row.externalIds.length > 0 && row.recommendations !== null,
    );
    if (sourceRows.length === 0) return;
    const recommendations = mergeCanonicalRecommendations(
      sourceRows.map((row) => recommendationItems(row.recommendations)),
      familyTmdbIds,
    );
    await tx.mediaItem.update({
      where: { id: targetMediaId },
      data: {
        recommendations: recommendations as unknown as Prisma.InputJsonValue,
        recommendationsSyncedAt: new Date(),
      },
    });
  }

  /** Keep denormalized header/search inventory aligned with the active regular graph. */
  private async recomputeShowInventory(
    tx: Prisma.TransactionClient,
    mediaId: string,
  ): Promise<void> {
    const show = await tx.show.findUnique({
      where: { mediaId },
      select: { id: true },
    });
    if (!show) throw new Error(`canonical target ${mediaId} has no show row`);
    const regularSeasons = await tx.season.findMany({
      where: {
        showId: show.id,
        isSpecial: false,
        episodes: { some: { structureState: 'ACTIVE' } },
      },
      select: { id: true },
    });
    const episodesCount = regularSeasons.length
      ? await tx.episode.count({
          where: {
            seasonId: { in: regularSeasons.map((season) => season.id) },
            structureState: 'ACTIVE',
          },
        })
      : 0;
    await tx.show.update({
      where: { id: show.id },
      data: { seasonsCount: regularSeasons.length, episodesCount },
    });
  }

  private async ledger(
    tx: Prisma.TransactionClient,
    linkId: string,
    entityType: string,
    sourceId: string,
    targetId: string,
  ) {
    await tx.mediaCanonicalCopy.upsert({
      where: { linkId_entityType_sourceId: { linkId, entityType, sourceId } },
      create: { linkId, entityType, sourceId, targetId },
      update: { targetId },
    });
  }

  private async copyEpisode(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    pair: EpisodePair,
    affectedUsers: Set<string>,
    ledgerSuffix = '',
  ) {
    const { source, target } = pair;
    const record = (type: string, sourceId: string, targetId: string) =>
      this.ledger(tx, linkId, type + ledgerSuffix, sourceId, targetId);
    await record(ENTITY.EPISODE, source.id, target.id);
    const externalReviewIds = await this.relinkExternalReviews(
      tx,
      'episode',
      source.id,
      target.id,
      affectedUsers,
    );

    for (const status of await tx.userEpisodeStatus.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(status.userId);
      const existing = await tx.userEpisodeStatus.findUnique({
        where: { userId_episodeId: { userId: status.userId, episodeId: target.id } },
      });
      const targetStatus = existing
        ? await tx.userEpisodeStatus.update({
            where: { id: existing.id },
            data: {
              watched: existing.watched || status.watched,
              watchedAt:
                [existing.watchedAt, status.watchedAt]
                  .filter((value): value is Date => !!value)
                  .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
              watchCount: Math.max(existing.watchCount, status.watchCount),
              device: existing.device ?? status.device,
              deviceSource: existing.device != null ? existing.deviceSource : status.deviceSource,
            },
          })
        : await tx.userEpisodeStatus.create({
            data: {
              userId: status.userId,
              episodeId: target.id,
              watched: status.watched,
              watchedAt: status.watchedAt,
              watchCount: status.watchCount,
              device: status.device,
              deviceSource: status.deviceSource,
              createdAt: status.createdAt,
              source: status.source,
              sourceKey: status.sourceKey,
            },
          });
      await record(ENTITY.EPISODE_STATUS, status.id, targetStatus.id);
    }

    for (const history of await tx.watchHistory.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(history.userId);
      let targetHistory = await tx.watchHistory.findFirst({
        where: { userId: history.userId, episodeId: target.id, watchedAt: history.watchedAt },
        select: { id: true },
      });
      if (!targetHistory) {
        targetHistory = await tx.watchHistory.create({
          data: {
            userId: history.userId,
            mediaId: targetMediaId,
            mediaType: history.mediaType,
            episodeId: target.id,
            seasonNumber: target.seasonNumber,
            episodeNumber: target.number,
            runtimeMinutes: history.runtimeMinutes,
            watchedAt: history.watchedAt,
            createdAt: history.createdAt,
            source: history.source,
            sourceKey: history.sourceKey,
          },
          select: { id: true },
        });
      }
      await record(ENTITY.WATCH_HISTORY, history.id, targetHistory.id);
    }

    for (const rating of await tx.rating.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(rating.userId);
      const existing = await tx.rating.findUnique({
        where: { userId_episodeId: { userId: rating.userId, episodeId: target.id } },
      });
      const targetRating = existing
        ? preferIncoming(rating, existing)
          ? await tx.rating.update({
              where: { id: existing.id },
              data: { rating: rating.rating, source: rating.source, sourceKey: rating.sourceKey },
            })
          : existing
        : await tx.rating.create({
            data: {
              userId: rating.userId,
              episodeId: target.id,
              rating: rating.rating,
              source: rating.source,
              sourceKey: rating.sourceKey,
              createdAt: rating.createdAt,
            },
          });
      await record(ENTITY.RATING, rating.id, targetRating.id);
    }

    for (const reaction of await tx.reaction.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(reaction.userId);
      const existing = await tx.reaction.findUnique({
        where: {
          userId_episodeId_reaction: {
            userId: reaction.userId,
            episodeId: target.id,
            reaction: reaction.reaction,
          },
        },
      });
      const targetReaction = existing
        ? preferIncoming(reaction, existing)
          ? await tx.reaction.update({
              where: { id: existing.id },
              data: {
                source: reaction.source,
                sourceKey: reaction.sourceKey,
                updatedAt: reaction.updatedAt,
              },
            })
          : existing
        : await tx.reaction.create({
            data: {
              userId: reaction.userId,
              episodeId: target.id,
              reaction: reaction.reaction,
              source: reaction.source,
              sourceKey: reaction.sourceKey,
              createdAt: reaction.createdAt,
              updatedAt: reaction.updatedAt,
            },
          });
      await record(ENTITY.REACTION, reaction.id, targetReaction.id);
    }

    for (const vote of await tx.characterVote.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(vote.userId);
      const targetCastId = await this.ensureTargetCast(tx, vote.castId, targetMediaId, linkId);
      const existing = await tx.characterVote.findUnique({
        where: { userId_episodeId: { userId: vote.userId, episodeId: target.id } },
      });
      const targetVote = existing
        ? preferIncoming(vote, existing)
          ? await tx.characterVote.update({
              where: { id: existing.id },
              data: { castId: targetCastId, source: vote.source, sourceKey: vote.sourceKey },
            })
          : existing
        : await tx.characterVote.create({
            data: {
              userId: vote.userId,
              episodeId: target.id,
              castId: targetCastId,
              source: vote.source,
              sourceKey: vote.sourceKey,
              createdAt: vote.createdAt,
            },
          });
      await record(ENTITY.CHARACTER_VOTE, vote.id, targetVote.id);
    }

    await this.cloneComments(
      tx,
      linkId,
      CommentThreadType.EPISODE,
      source.id,
      target.id,
      sourceMediaId,
      targetMediaId,
      affectedUsers,
      externalReviewIds,
      ledgerSuffix,
    );
  }

  private async copyMediaData(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
    mediaType: 'SHOW' | 'MOVIE' = 'SHOW',
  ) {
    const externalReviewIds = await this.relinkExternalReviews(
      tx,
      'media',
      sourceMediaId,
      targetMediaId,
      affectedUsers,
    );
    for (const status of mediaType === 'MOVIE'
      ? []
      : await tx.userShowStatus.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(status.userId);
      const existing = await tx.userShowStatus.findUnique({
        where: { userId_mediaId: { userId: status.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? await tx.userShowStatus.update({
            where: { id: existing.id },
            data: {
              dropped: existing.dropped || status.dropped,
              rewatchStartedAt: existing.rewatchStartedAt ?? status.rewatchStartedAt,
              pausedAt:
                [existing.pausedAt, status.pausedAt]
                  .filter((value): value is Date => !!value)
                  .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
              lastWatchedAt:
                [existing.lastWatchedAt, status.lastWatchedAt]
                  .filter((value): value is Date => !!value)
                  .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
            },
          })
        : await tx.userShowStatus.create({
            data: {
              userId: status.userId,
              mediaId: targetMediaId,
              watchedCount: 0,
              totalCount: 0,
              lastWatchedAt: status.lastWatchedAt,
              dropped: status.dropped,
              pausedAt: status.pausedAt,
              rewatchStartedAt: status.rewatchStartedAt,
              createdAt: status.createdAt,
            },
          });
      await this.ledger(tx, linkId, ENTITY.SHOW_STATUS, status.id, target.id);
    }

    if (mediaType === 'MOVIE')
      for (const status of await tx.userMovieStatus.findMany({
        where: { mediaId: sourceMediaId },
      })) {
        affectedUsers.add(status.userId);
        const existing = await tx.userMovieStatus.findUnique({
          where: { userId_mediaId: { userId: status.userId, mediaId: targetMediaId } },
        });
        const target = existing
          ? await tx.userMovieStatus.update({
              where: { id: existing.id },
              data: {
                watched: existing.watched || status.watched,
                watchCount: Math.max(existing.watchCount, status.watchCount),
                watchedAt:
                  [existing.watchedAt, status.watchedAt]
                    .filter((v): v is Date => !!v)
                    .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
              },
            })
          : await tx.userMovieStatus.create({
              data: { ...status, id: undefined, mediaId: targetMediaId },
            });
        await this.ledger(tx, linkId, ENTITY.MOVIE_STATUS, status.id, target.id);
      }

    for (const item of await tx.watchlistItem.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(item.userId);
      const existing = await tx.watchlistItem.findUnique({
        where: { userId_mediaId: { userId: item.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? await tx.watchlistItem.update({
            where: { id: existing.id },
            data: {
              priority: Math.max(existing.priority, item.priority),
              createdAt: existing.createdAt < item.createdAt ? existing.createdAt : item.createdAt,
            },
          })
        : await tx.watchlistItem.create({
            data: { ...item, id: undefined, mediaId: targetMediaId },
          });
      if (!existing) {
        await tx.mediaItem.update({
          where: { id: targetMediaId },
          data: { addedCount: { increment: 1 } },
        });
      }
      await this.ledger(tx, linkId, ENTITY.WATCHLIST, item.id, target.id);
    }

    for (const favorite of await tx.favorite.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(favorite.userId);
      const existing = await tx.favorite.findUnique({
        where: { userId_mediaId: { userId: favorite.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? existing
        : await tx.favorite.create({
            data: {
              ...favorite,
              id: undefined,
              mediaId: targetMediaId,
            },
          });
      await this.ledger(tx, linkId, ENTITY.FAVORITE, favorite.id, target.id);
    }

    for (const item of await tx.customListItem.findMany({ where: { mediaId: sourceMediaId } })) {
      const existing = await tx.customListItem.findUnique({
        where: { listId_mediaId: { listId: item.listId, mediaId: targetMediaId } },
      });
      const target = existing
        ? await tx.customListItem.update({
            where: { id: existing.id },
            data: { order: Math.min(existing.order, item.order) },
          })
        : await tx.customListItem.create({
            data: {
              listId: item.listId,
              mediaId: targetMediaId,
              order: item.order,
              createdAt: item.createdAt,
            },
          });
      await this.ledger(tx, linkId, ENTITY.LIST_ITEM, item.id, target.id);
    }

    for (const alert of await tx.watchProviderAlert.findMany({
      where: { mediaId: sourceMediaId },
    })) {
      affectedUsers.add(alert.userId);
      const existing = await tx.watchProviderAlert.findUnique({
        where: {
          userId_mediaId_offerType: {
            userId: alert.userId,
            mediaId: targetMediaId,
            offerType: alert.offerType,
          },
        },
      });
      const target = existing
        ? await tx.watchProviderAlert.update({
            where: { id: existing.id },
            data: {
              active: existing.active || alert.active,
              providerIds:
                !existing.providerIds.length || !alert.providerIds.length
                  ? []
                  : [...new Set([...existing.providerIds, ...alert.providerIds])],
              createdAt:
                existing.createdAt < alert.createdAt ? existing.createdAt : alert.createdAt,
              notifiedAt: existing.notifiedAt ?? alert.notifiedAt,
            },
          })
        : await tx.watchProviderAlert.create({
            data: {
              userId: alert.userId,
              mediaId: targetMediaId,
              offerType: alert.offerType,
              country: alert.country,
              providerIds: alert.providerIds,
              active: alert.active,
              createdAt: alert.createdAt,
              notifiedAt: alert.notifiedAt,
            },
          });
      await this.ledger(tx, linkId, ENTITY.PROVIDER_ALERT, alert.id, target.id);
    }

    for (const history of await tx.watchHistory.findMany({
      where: { mediaId: sourceMediaId, episodeId: null },
    })) {
      affectedUsers.add(history.userId);
      let target = await tx.watchHistory.findFirst({
        where: {
          userId: history.userId,
          mediaId: targetMediaId,
          episodeId: null,
          watchedAt: history.watchedAt,
        },
        select: { id: true },
      });
      if (!target) {
        target = await tx.watchHistory.create({
          data: { ...history, id: undefined, mediaId: targetMediaId },
          select: { id: true },
        });
      }
      await this.ledger(tx, linkId, ENTITY.WATCH_HISTORY, history.id, target.id);
    }

    await this.copyMediaRatings(tx, linkId, sourceMediaId, targetMediaId, affectedUsers);
    await this.copyMediaReactions(tx, linkId, sourceMediaId, targetMediaId, affectedUsers);
    await this.copyMediaVotes(tx, linkId, sourceMediaId, targetMediaId, affectedUsers);
    await this.cloneComments(
      tx,
      linkId,
      mediaType === 'MOVIE' ? CommentThreadType.MOVIE : CommentThreadType.SHOW,
      sourceMediaId,
      targetMediaId,
      sourceMediaId,
      targetMediaId,
      affectedUsers,
      externalReviewIds,
    );
  }

  private async copyMediaRatings(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
  ) {
    for (const rating of await tx.rating.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(rating.userId);
      const existing = await tx.rating.findUnique({
        where: { userId_mediaId: { userId: rating.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? preferIncoming(rating, existing)
          ? await tx.rating.update({
              where: { id: existing.id },
              data: { rating: rating.rating, source: rating.source, sourceKey: rating.sourceKey },
            })
          : existing
        : await tx.rating.create({
            data: { ...rating, id: undefined, mediaId: targetMediaId },
          });
      await this.ledger(tx, linkId, ENTITY.RATING, rating.id, target.id);
    }
  }

  private async copyMediaReactions(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
  ) {
    for (const reaction of await tx.reaction.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(reaction.userId);
      const existing = await tx.reaction.findUnique({
        where: {
          userId_mediaId_reaction: {
            userId: reaction.userId,
            mediaId: targetMediaId,
            reaction: reaction.reaction,
          },
        },
      });
      const target = existing
        ? preferIncoming(reaction, existing)
          ? await tx.reaction.update({
              where: { id: existing.id },
              data: {
                source: reaction.source,
                sourceKey: reaction.sourceKey,
                updatedAt: reaction.updatedAt,
              },
            })
          : existing
        : await tx.reaction.create({
            data: { ...reaction, id: undefined, mediaId: targetMediaId },
          });
      await this.ledger(tx, linkId, ENTITY.REACTION, reaction.id, target.id);
    }
  }

  private async copyMediaVotes(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
  ) {
    for (const vote of await tx.characterVote.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(vote.userId);
      const targetCastId = await this.ensureTargetCast(tx, vote.castId, targetMediaId, linkId);
      const existing = await tx.characterVote.findUnique({
        where: { userId_mediaId: { userId: vote.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? preferIncoming(vote, existing)
          ? await tx.characterVote.update({
              where: { id: existing.id },
              data: { castId: targetCastId, source: vote.source, sourceKey: vote.sourceKey },
            })
          : existing
        : await tx.characterVote.create({
            data: { ...vote, id: undefined, mediaId: targetMediaId, castId: targetCastId },
          });
      await this.ledger(tx, linkId, ENTITY.CHARACTER_VOTE, vote.id, target.id);
    }
  }

  private async ensureTargetCast(
    tx: Prisma.TransactionClient,
    sourceCastId: string,
    targetMediaId: string,
    linkId?: string,
  ): Promise<string> {
    const source = await tx.mediaCast.findUnique({
      where: { id: sourceCastId },
      include: { externalIds: true, castMember: true },
    });
    if (!source) throw new Error(`source cast ${sourceCastId} no longer exists`);
    let target = await tx.mediaCast.findUnique({
      where: {
        mediaId_castMemberId: { mediaId: targetMediaId, castMemberId: source.castMemberId },
      },
    });
    if (source.externalIds.length || source.characterExternalId) {
      const aliasOwners = source.externalIds.length
        ? await tx.mediaCastExternalId.findMany({
            where: {
              mediaId: targetMediaId,
              OR: source.externalIds.map((id) => ({ provider: id.provider, value: id.value })),
            },
            select: { castId: true },
          })
        : [];
      const legacyOwners = source.characterExternalId
        ? await tx.mediaCast.findMany({
            where: { mediaId: targetMediaId, characterExternalId: source.characterExternalId },
            select: { id: true },
          })
        : [];
      const owners = [
        ...new Set([...aliasOwners.map((o) => o.castId), ...legacyOwners.map((o) => o.id)]),
      ];
      if (owners.length > 1 || (target && owners.length && owners[0] !== target.id))
        throw new Error('Conflicting title-specific cast alias owners');
      if (!target && owners.length)
        target = await tx.mediaCast.findUnique({ where: { id: owners[0] } });
    }
    if (!target && source.castMember) {
      const person = source.castMember;
      const identities = [
        ...(person.tmdbId ? [{ tmdbId: person.tmdbId }] : []),
        ...(person.tvdbId ? [{ tvdbId: person.tvdbId }] : []),
        ...(person.imdbId ? [{ imdbId: person.imdbId }] : []),
      ];
      if (identities.length && norm(source.character)) {
        const matches = (
          await tx.mediaCast.findMany({
            where: { mediaId: targetMediaId, castMember: { OR: identities } },
          })
        ).filter((row) => norm(row.character) === norm(source.character));
        if (matches.length > 1)
          throw new Error('Multiple cast credits match the verified person and role');
        target = matches[0] ?? null;
      }
    }
    if (
      target &&
      source.characterExternalId &&
      target.characterExternalId &&
      source.characterExternalId !== target.characterExternalId
    ) {
      throw new Error('Conflicting title-specific character roles require review');
    }
    if (
      target &&
      norm(source.character) &&
      norm(target.character) &&
      norm(source.character) !== norm(target.character) &&
      !(source.characterExternalId && source.characterExternalId === target.characterExternalId)
    ) {
      throw new Error('Character role equivalence is unproven');
    }
    if (!target) {
      target = await tx.mediaCast.create({
        data: {
          mediaId: targetMediaId,
          castMemberId: source.castMemberId,
          character: source.character,
          characterImageUrl: source.characterImageUrl,
          characters: source.characters as Prisma.InputJsonValue | undefined,
          sortOrder: source.sortOrder,
          seasonNumber: source.seasonNumber,
          characterExternalId: source.characterExternalId,
        },
      });
    } else if (!target.characterImageUrl && source.characterImageUrl) {
      target = await tx.mediaCast.update({
        where: { id: target.id },
        data: { characterImageUrl: source.characterImageUrl },
      });
    }
    for (const external of source.externalIds) {
      const alias = await tx.mediaCastExternalId.upsert({
        where: {
          mediaId_provider_value: {
            mediaId: targetMediaId,
            provider: external.provider,
            value: external.value,
          },
        },
        create: {
          mediaId: targetMediaId,
          castId: target.id,
          provider: external.provider,
          value: external.value,
        },
        update: {},
      });
      if (alias.castId !== target.id) throw new Error('Cast alias was acquired by another credit');
    }
    if (linkId) await this.ledger(tx, linkId, ENTITY.CAST, sourceCastId, target.id);
    return target.id;
  }

  private async cloneComments(
    tx: Prisma.TransactionClient,
    linkId: string,
    threadType: CommentThreadType,
    sourceThreadId: string,
    targetThreadId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
    externalReviewIds: Set<string> = new Set(),
    ledgerSuffix = '',
  ) {
    const comments = await tx.comment.findMany({
      where: { threadType, threadId: sourceThreadId },
      orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: { likes: true, spoilerReports: true, image: true },
    });
    const cloned = new Map<string, string>();
    const prior = await tx.mediaCanonicalCopy.findMany({
      where: {
        linkId,
        entityType: ENTITY.COMMENT + ledgerSuffix,
        sourceId: { in: comments.map((row) => row.id) },
      },
      select: { sourceId: true, targetId: true },
    });
    for (const row of prior) {
      if (await tx.comment.findUnique({ where: { id: row.targetId }, select: { id: true } })) {
        cloned.set(row.sourceId, row.targetId);
      }
    }
    for (const source of comments) {
      affectedUsers.add(source.userId);
      if (cloned.has(source.id)) continue;
      const parentId = source.parentId ? cloned.get(source.parentId) : null;
      const rootId = source.rootId ? cloned.get(source.rootId) : null;
      if (source.parentId && !parentId)
        throw new Error(`comment ${source.id} has an unmapped parent`);
      if (source.rootId && !rootId) throw new Error(`comment ${source.id} has an unmapped root`);
      const hasMediaAttachment = !!(source.mediaType && source.mediaId);
      const target = await tx.comment.create({
        data: {
          userId: source.userId,
          parentId,
          depth: source.depth,
          rootId,
          threadType,
          threadId: targetThreadId,
          body: source.body,
          imageUrl: source.imageUrl,
          gifUrl: source.gifUrl,
          mediaType: hasMediaAttachment ? source.mediaType : null,
          mediaId: hasMediaAttachment
            ? source.mediaId === sourceMediaId
              ? targetMediaId
              : source.mediaId
            : null,
          listId: source.listId,
          isSpoiler: source.isSpoiler,
          spoilerCount: source.spoilerCount,
          externalReviewId:
            source.externalReviewId && externalReviewIds.has(source.externalReviewId)
              ? source.externalReviewId
              : null,
          parentSourceKey: source.parentSourceKey,
          language: source.language,
          translations: source.translations as Prisma.InputJsonValue,
          source: source.source,
          sourceKey: source.sourceKey,
          // Copies retain lineage, not ownership of an upstream publication.
          commsUniOriginId: source.commsUniOriginId ?? source.id,
          likesCount: source.likesCount,
          repliesCount: source.repliesCount,
          hidden: source.hidden,
          adminDeleted: source.adminDeleted,
          deletedByUser: source.deletedByUser,
          editedAt: source.editedAt,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        },
      });
      cloned.set(source.id, target.id);
      await this.ledger(tx, linkId, ENTITY.COMMENT + ledgerSuffix, source.id, target.id);
      if (source.likes.length) {
        await tx.commentLike.createMany({
          data: source.likes.map((like) => ({
            userId: like.userId,
            commentId: target.id,
            createdAt: like.createdAt,
          })),
          skipDuplicates: true,
        });
      }
      if (source.spoilerReports.length) {
        await tx.commentSpoilerReport.createMany({
          data: source.spoilerReports.map((report) => ({
            userId: report.userId,
            commentId: target.id,
            createdAt: report.createdAt,
          })),
          skipDuplicates: true,
        });
      }
      if (source.image?.status === 'ready') {
        const { id, commentId, tempStorageKey, deletedAt, ...image } = source.image;
        void id;
        void commentId;
        void tempStorageKey;
        void deletedAt;
        await tx.commentImage.create({
          data: {
            ...image,
            commentId: target.id,
            tempStorageKey: null,
            deletedAt: null,
            moderationCategories:
              image.moderationCategories === null
                ? Prisma.JsonNull
                : (image.moderationCategories as Prisma.InputJsonValue),
            moderationCategoryScores:
              image.moderationCategoryScores === null
                ? Prisma.JsonNull
                : (image.moderationCategoryScores as Prisma.InputJsonValue),
          },
        });
      }
    }
  }

  /**
   * Provider reviews are thread roots for user replies. Move those roots in the same
   * transaction as the canonical cutover, then let cloned replies keep the same FK.
   * Likes move automatically with the review row and their owners are cache-invalidated.
   */
  private async relinkExternalReviews(
    tx: Prisma.TransactionClient,
    kind: 'media' | 'episode',
    sourceId: string,
    targetId: string,
    affectedUsers: Set<string>,
  ): Promise<Set<string>> {
    const reviews = await tx.externalReview.findMany({
      where: kind === 'media' ? { mediaId: sourceId } : { episodeId: sourceId },
      select: {
        id: true,
        likes: { select: { userId: true } },
        comments: { select: { userId: true } },
      },
    });
    for (const review of reviews) {
      for (const like of review.likes) affectedUsers.add(like.userId);
      for (const comment of review.comments) affectedUsers.add(comment.userId);
    }
    const ids = new Set(reviews.map((review) => review.id));
    if (ids.size > 0) {
      await tx.externalReview.updateMany({
        where: { id: { in: [...ids] } },
        data:
          kind === 'media'
            ? { mediaId: targetId, episodeId: null }
            : { episodeId: targetId, mediaId: null },
      });
    }
    return ids;
  }

  private async recomputeShowStatuses(
    tx: Prisma.TransactionClient,
    mediaId: string,
    users: Set<string>,
  ) {
    if (users.size === 0) return;
    const now = new Date();
    const totalCount = await tx.episode.count({
      where: {
        structureState: 'ACTIVE',
        ...episodeProgressEligibilityWhere(now),
        season: { isSpecial: false, show: { mediaId } },
      },
    });
    for (const userId of users) {
      const [showStatus, episodeStatusCount] = await Promise.all([
        tx.userShowStatus.findUnique({
          where: { userId_mediaId: { userId, mediaId } },
          select: { id: true },
        }),
        tx.userEpisodeStatus.count({
          where: { userId, episode: { season: { show: { mediaId } } } },
        }),
      ]);
      if (!showStatus && episodeStatusCount === 0) continue;
      const [watchedCount, latest] = await Promise.all([
        tx.userEpisodeStatus.count({
          where: {
            userId,
            watched: true,
            episode: {
              structureState: 'ACTIVE',
              ...episodeProgressEligibilityWhere(now),
              season: { isSpecial: false, show: { mediaId } },
            },
          },
        }),
        tx.userEpisodeStatus.findFirst({
          where: {
            userId,
            watched: true,
            episode: {
              structureState: 'ACTIVE',
              ...episodeProgressEligibilityWhere(now),
              season: { isSpecial: false, show: { mediaId } },
            },
          },
          select: { watchedAt: true },
          orderBy: { watchedAt: 'desc' },
        }),
      ]);
      await tx.userShowStatus.upsert({
        where: { userId_mediaId: { userId, mediaId } },
        create: {
          userId,
          mediaId,
          watchedCount,
          totalCount,
          lastWatchedAt: latest?.watchedAt ?? null,
        },
        update: { watchedCount, totalCount, lastWatchedAt: latest?.watchedAt ?? null },
      });
    }
  }

  private async verifyCopy(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    sourceEpisodeIds: string[],
    mediaType: 'SHOW' | 'MOVIE' = 'SHOW',
    splitPairs: EpisodePair[] = [],
  ): Promise<{ rows: number; byType: Record<string, number> }> {
    const expected: Record<string, number> = {
      [ENTITY.EPISODE]: sourceEpisodeIds.length,
      [ENTITY.EPISODE_STATUS]: await tx.userEpisodeStatus.count({
        where: { episodeId: { in: sourceEpisodeIds } },
      }),
      [ENTITY.WATCH_HISTORY]: await tx.watchHistory.count({
        where: {
          OR: [
            { episodeId: { in: sourceEpisodeIds } },
            { mediaId: sourceMediaId, episodeId: null },
          ],
        },
      }),
      [ENTITY.RATING]: await tx.rating.count({
        where: { OR: [{ episodeId: { in: sourceEpisodeIds } }, { mediaId: sourceMediaId }] },
      }),
      [ENTITY.REACTION]: await tx.reaction.count({
        where: { OR: [{ episodeId: { in: sourceEpisodeIds } }, { mediaId: sourceMediaId }] },
      }),
      [ENTITY.CHARACTER_VOTE]: await tx.characterVote.count({
        where: { OR: [{ episodeId: { in: sourceEpisodeIds } }, { mediaId: sourceMediaId }] },
      }),
      [ENTITY.COMMENT]: await tx.comment.count({
        where: {
          OR: [
            { threadType: CommentThreadType.EPISODE, threadId: { in: sourceEpisodeIds } },
            {
              threadType: mediaType === 'MOVIE' ? CommentThreadType.MOVIE : CommentThreadType.SHOW,
              threadId: sourceMediaId,
            },
          ],
        },
      }),
      [ENTITY.MOVIE_STATUS]:
        mediaType === 'MOVIE'
          ? await tx.userMovieStatus.count({ where: { mediaId: sourceMediaId } })
          : 0,
      [ENTITY.SHOW_STATUS]: await tx.userShowStatus.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.WATCHLIST]: await tx.watchlistItem.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.FAVORITE]: await tx.favorite.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.LIST_ITEM]: await tx.customListItem.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.PROVIDER_ALERT]: await tx.watchProviderAlert.count({
        where: { mediaId: sourceMediaId },
      }),
    };
    for (const pair of splitPairs) {
      const suffix = `:split:${pair.target.id}`;
      expected[ENTITY.EPISODE + suffix] = (expected[ENTITY.EPISODE + suffix] ?? 0) + 1;
      for (const [entity, model] of [
        [ENTITY.EPISODE_STATUS, 'userEpisodeStatus'],
        [ENTITY.WATCH_HISTORY, 'watchHistory'],
        [ENTITY.RATING, 'rating'],
        [ENTITY.REACTION, 'reaction'],
        [ENTITY.CHARACTER_VOTE, 'characterVote'],
      ] as const) {
        expected[entity + suffix] =
          (expected[entity + suffix] ?? 0) +
          (await (tx[model] as any).count({ where: { episodeId: pair.source.id } }));
      }
      expected[ENTITY.COMMENT + suffix] =
        (expected[ENTITY.COMMENT + suffix] ?? 0) +
        (await tx.comment.count({ where: { threadType: 'EPISODE', threadId: pair.source.id } }));
    }
    const grouped = await tx.mediaCanonicalCopy.groupBy({
      by: ['entityType'],
      where: { linkId },
      _count: { _all: true },
    });
    const actual = new Map(grouped.map((row) => [row.entityType, row._count._all]));
    for (const [entityType, count] of Object.entries(expected)) {
      if ((actual.get(entityType) ?? 0) !== count) {
        throw new Error(
          `verification failed for ${entityType}: expected ${count}, copied ${actual.get(entityType) ?? 0}`,
        );
      }
    }
    return {
      rows: Object.values(expected).reduce((sum, count) => sum + count, 0),
      byType: expected,
    };
  }
}
