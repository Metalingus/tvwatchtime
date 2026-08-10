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
  externalIds: Array<{ provider: ExternalProvider; value: string }>;
};

type GraphSeason = {
  number: number;
  isSpecial: boolean;
  episodes: GraphEpisode[];
};

type ShowGraph = {
  id: string;
  title: string;
  normalizedTitle: string;
  structureProvider: 'TMDB' | 'TVDB' | null;
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
  EPISODE_STATUS: 'EPISODE_STATUS',
  WATCH_HISTORY: 'WATCH_HISTORY',
  RATING: 'RATING',
  REACTION: 'REACTION',
  CHARACTER_VOTE: 'CHARACTER_VOTE',
  COMMENT: 'COMMENT',
  SHOW_STATUS: 'SHOW_STATUS',
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
  ) {}

  /** Resolve old show URLs, cached IDs, and import matches only after a verified cutover. */
  async resolveMediaId(mediaId: string): Promise<string> {
    let current = mediaId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 5 && !visited.has(current); depth++) {
      visited.add(current);
      const link = await this.prisma.mediaCanonicalLink.findUnique({
        where: { sourceMediaId: current },
        select: { targetMediaId: true, status: true },
      });
      if (!link || link.status !== MediaCanonicalStatus.ACTIVE) return current;
      current = link.targetMediaId;
    }
    return current;
  }

  /** Resolve old episode URLs and provider matches through the immutable episode copy map. */
  async resolveEpisodeId(episodeId: string): Promise<string> {
    let current = episodeId;
    const visited = new Set<string>();
    for (let depth = 0; depth < 5 && !visited.has(current); depth++) {
      visited.add(current);
      const copy = await this.prisma.mediaCanonicalCopy.findFirst({
        where: {
          entityType: ENTITY.EPISODE,
          sourceId: current,
          link: { status: MediaCanonicalStatus.ACTIVE },
        },
        select: { targetId: true },
        orderBy: { createdAt: 'desc' },
      });
      if (!copy) return current;
      current = copy.targetId;
    }
    return current;
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

  private async loadGraph(mediaId: string): Promise<ShowGraph | null> {
    const row = await this.prisma.mediaItem.findUnique({
      where: { id: mediaId },
      select: {
        id: true,
        title: true,
        normalizedTitle: true,
        externalIds: { select: { provider: true, providerEntityKind: true, value: true } },
        show: {
          select: {
            structureProvider: true,
            seasons: {
              orderBy: { number: 'asc' },
              select: {
                number: true,
                isSpecial: true,
                episodes: {
                  where: { structureState: 'ACTIVE' },
                  orderBy: { number: 'asc' },
                  select: {
                    id: true,
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
    if (!row?.show) return null;
    return {
      id: row.id,
      title: row.title,
      normalizedTitle: row.normalizedTitle,
      structureProvider: row.show.structureProvider,
      externalIds: row.externalIds,
      seasons: row.show.seasons.map((season) => ({
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
    const sourceRegular = source.seasons.filter((season) => !season.isSpecial);
    const targetRegular = target.seasons.filter((season) => !season.isSpecial);
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
    if (targetSourceLink) {
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
            ...new Set(actionable.flatMap((plan) => [plan.source.id, plan.target.id])),
          ].sort();
          await tx.$queryRaw(
            Prisma.sql`SELECT id FROM media_items WHERE id IN (${Prisma.join(
              lockIds,
            )}) ORDER BY id FOR UPDATE`,
          );

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
                evidence: evidence as Prisma.InputJsonValue,
              },
              update: {
                targetMediaId: plan.target.id,
                relation: plan.match.relation,
                targetSeasonNumber: plan.match.targetSeasonNumber,
                status: MediaCanonicalStatus.COPYING,
                evidence: evidence as Prisma.InputJsonValue,
                lastError: null,
                activatedAt: null,
              },
              select: { id: true },
            });
            const supplementalPairs = await this.ensureSupplementalSpecialPairs(tx, plan);
            transactionPlans.push({
              ...plan,
              linkId: link.id,
              copyPairs: [...plan.match.pairs, ...supplementalPairs],
            });
          }
          if (transactionPlans.length === 0) {
            return { activated: 0, rows: 0, affectedUserIds: [] as string[] };
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
          const activeEpisodeCount = await tx.episode.count({
            where: { id: { in: episodeIds }, structureState: 'ACTIVE' },
          });
          if (activeEpisodeCount !== episodeIds.length) {
            throw new Error(
              `structure changed during canonicalization (${activeEpisodeCount}/${episodeIds.length} active episode endpoints)`,
            );
          }

          const affectedUsers = new Set<string>();
          for (const plan of transactionPlans) {
            for (const pair of plan.copyPairs) {
              await this.copyEpisode(
                tx,
                plan.linkId,
                plan.source.id,
                plan.target.id,
                pair,
                affectedUsers,
              );
            }
            await this.copyMediaData(
              tx,
              plan.linkId,
              plan.source.id,
              plan.target.id,
              affectedUsers,
            );
          }
          for (const targetMediaId of new Set(transactionPlans.map((plan) => plan.target.id))) {
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
              plan.copyPairs.map((pair) => pair.source.id),
            );
            verifiedPlans.push({ linkId: plan.linkId, report: verified });
          }

          // This loop is intentionally last. All links become ACTIVE in the same commit,
          // after all copies and every per-source ledger count have passed.
          const activatedAt = new Date();
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
          this.redis.delByPattern(`foryou:v3:${userId}:*`),
          this.redis.del(`watchnext:${userId}`),
          this.redis.del(`upcoming:${userId}`),
        ]).catch(() => undefined);
        this.events.emit('import.applied', { userId });
      }
      return report.activated;
    } catch (error) {
      await this.recordPlanFailure(actionable, evidence, error);
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
          airDate: { lte: now },
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
  ) {
    const { source, target } = pair;
    await this.ledger(tx, linkId, ENTITY.EPISODE, source.id, target.id);
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
              createdAt: status.createdAt,
            },
          });
      await this.ledger(tx, linkId, ENTITY.EPISODE_STATUS, status.id, targetStatus.id);
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
          },
          select: { id: true },
        });
      }
      await this.ledger(tx, linkId, ENTITY.WATCH_HISTORY, history.id, targetHistory.id);
    }

    for (const rating of await tx.rating.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(rating.userId);
      const existing = await tx.rating.findUnique({
        where: { userId_episodeId: { userId: rating.userId, episodeId: target.id } },
      });
      const targetRating = existing
        ? newest(rating, existing)
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
      await this.ledger(tx, linkId, ENTITY.RATING, rating.id, targetRating.id);
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
        ? newest(reaction, existing)
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
      await this.ledger(tx, linkId, ENTITY.REACTION, reaction.id, targetReaction.id);
    }

    for (const vote of await tx.characterVote.findMany({ where: { episodeId: source.id } })) {
      affectedUsers.add(vote.userId);
      const targetCastId = await this.ensureTargetCast(tx, vote.castId, targetMediaId);
      const existing = await tx.characterVote.findUnique({
        where: { userId_episodeId: { userId: vote.userId, episodeId: target.id } },
      });
      const targetVote = existing
        ? vote.createdAt.getTime() > existing.createdAt.getTime()
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
      await this.ledger(tx, linkId, ENTITY.CHARACTER_VOTE, vote.id, targetVote.id);
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
    );
  }

  private async copyMediaData(
    tx: Prisma.TransactionClient,
    linkId: string,
    sourceMediaId: string,
    targetMediaId: string,
    affectedUsers: Set<string>,
  ) {
    const externalReviewIds = await this.relinkExternalReviews(
      tx,
      'media',
      sourceMediaId,
      targetMediaId,
      affectedUsers,
    );
    for (const status of await tx.userShowStatus.findMany({ where: { mediaId: sourceMediaId } })) {
      affectedUsers.add(status.userId);
      const existing = await tx.userShowStatus.findUnique({
        where: { userId_mediaId: { userId: status.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? await tx.userShowStatus.update({
            where: { id: existing.id },
            data: {
              dropped: existing.dropped || status.dropped,
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
              createdAt: status.createdAt,
            },
          });
      await this.ledger(tx, linkId, ENTITY.SHOW_STATUS, status.id, target.id);
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
              userId: favorite.userId,
              mediaId: targetMediaId,
              createdAt: favorite.createdAt,
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
              providerIds: [...new Set([...existing.providerIds, ...alert.providerIds])],
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
      CommentThreadType.SHOW,
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
        ? newest(rating, existing)
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
        ? newest(reaction, existing)
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
      const targetCastId = await this.ensureTargetCast(tx, vote.castId, targetMediaId);
      const existing = await tx.characterVote.findUnique({
        where: { userId_mediaId: { userId: vote.userId, mediaId: targetMediaId } },
      });
      const target = existing
        ? vote.createdAt.getTime() > existing.createdAt.getTime()
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
  ): Promise<string> {
    const source = await tx.mediaCast.findUnique({
      where: { id: sourceCastId },
      include: { externalIds: true },
    });
    if (!source) throw new Error(`source cast ${sourceCastId} no longer exists`);
    let target = await tx.mediaCast.findUnique({
      where: {
        mediaId_castMemberId: { mediaId: targetMediaId, castMemberId: source.castMemberId },
      },
    });
    if (!target) {
      target = await tx.mediaCast.create({
        data: {
          mediaId: targetMediaId,
          castMemberId: source.castMemberId,
          character: source.character,
          characters: source.characters as Prisma.InputJsonValue | undefined,
          sortOrder: source.sortOrder,
          seasonNumber: source.seasonNumber,
          characterExternalId: source.characterExternalId,
        },
      });
    }
    for (const external of source.externalIds) {
      await tx.mediaCastExternalId.upsert({
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
        update: { castId: target.id },
      });
    }
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
        entityType: ENTITY.COMMENT,
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
      await this.ledger(tx, linkId, ENTITY.COMMENT, source.id, target.id);
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
        OR: [{ airDate: null }, { airDate: { lte: now } }],
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
              OR: [{ airDate: null }, { airDate: { lte: now } }],
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
              OR: [{ airDate: null }, { airDate: { lte: now } }],
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
            { threadType: CommentThreadType.SHOW, threadId: sourceMediaId },
          ],
        },
      }),
      [ENTITY.SHOW_STATUS]: await tx.userShowStatus.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.WATCHLIST]: await tx.watchlistItem.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.FAVORITE]: await tx.favorite.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.LIST_ITEM]: await tx.customListItem.count({ where: { mediaId: sourceMediaId } }),
      [ENTITY.PROVIDER_ALERT]: await tx.watchProviderAlert.count({
        where: { mediaId: sourceMediaId },
      }),
    };
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
