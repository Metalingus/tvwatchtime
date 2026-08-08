import { Injectable, Logger, Optional } from '@nestjs/common';
import { EpisodeStructureState, Prisma, StructureProvider, StructureReason } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { TvdbProvider } from './providers/tvdb.provider';
import type { NormalizedSeason } from './providers/tmdb.provider';
import { STRUCTURE_RULE_VERSION } from './structure-authority.service';

export interface RemapStats {
  stale: number;
  mapped: number;
  unmapped: number;
  /** Pairs whose transfer transaction FAILED (kept both rows, will be retried —
   *  deliberately NOT counted in `unmapped`, which feeds the convergence stamps). */
  transferFailed: number;
  statusesMoved: number;
  historiesMoved: number;
  ratingsMoved: number;
  reactionsMoved: number;
  votesMoved: number;
  commentsMoved: number;
  externalReviewsMoved: number;
  legacyQuarantined: number;
  /** Provider-only S0 rows with user data kept ACTIVE as non-authoritative supplements. */
  specialsPreserved: number;
  episodesRemoved: number;
  seasonsRemoved: number;
  /** Rule that produced each mapping (external id, verified date, absolute, stored date). */
  matchRules: Record<string, number>;
  /** True when the run only computed matches (no writes). */
  dryRun: boolean;
  /** Strict migrations abort before writes when a user-data row has no proven target. */
  blocked: boolean;
  blockedReason?: 'UNMAPPED_USER_DATA' | 'TRANSFER_FAILED';
}

/** Read-only import bridge from authoritative TVDB episode ids to the active canonical graph. */
export interface CanonicalEpisodeAliasResolution {
  mappings: Map<string, string>;
  /** Values proven to belong to this show's complete TVDB routing snapshot. */
  verifiedValues: Set<string>;
  /** A 2:1 bridge passed runtime/date proof and differs by at most one episode per season. */
  safeManyToOne: boolean;
}

interface EpRow {
  id: string;
  number: number;
  absoluteNumber: number | null;
  title: string;
  airDate: Date | null;
  runtimeMinutes?: number | null;
  seasonId: string;
  seasonNumber: number;
  isSpecial: boolean;
  hasTmdb: boolean;
  hasTvdb: boolean;
  /** Actual provider id values (needed to MOVE the cross-link onto the target row). */
  tmdbValue: string | null;
  tvdbValue: string | null;
  /** All aliases are retained for detecting an old many-ids-to-one episode collapse. */
  tmdbValues: string[];
  tvdbValues: string[];
  structureState: EpisodeStructureState;
  /** Provider-returned date after the foreign episode id was verified under this show. */
  verifiedForeignAirDate?: Date | null;
  verifiedForeignSeasonNumber?: number | null;
  verifiedForeignEpisodeNumber?: number | null;
  verifiedForeignAbsoluteNumber?: number | null;
}

interface EpisodeMatch {
  from: EpRow;
  /** One target normally; two when a provider combined broadcast becomes split parts. */
  targets: EpRow[];
  rule: string;
}

interface TransferredUserData {
  statuses: number;
  histories: number;
  ratings: number;
  reactions: number;
  votes: number;
  comments: number;
  externalReviews: number;
}

const ZERO: RemapStats = {
  stale: 0,
  mapped: 0,
  unmapped: 0,
  transferFailed: 0,
  statusesMoved: 0,
  historiesMoved: 0,
  ratingsMoved: 0,
  reactionsMoved: 0,
  votesMoved: 0,
  commentsMoved: 0,
  externalReviewsMoved: 0,
  legacyQuarantined: 0,
  specialsPreserved: 0,
  episodesRemoved: 0,
  seasonsRemoved: 0,
  matchRules: {},
  dryRun: false,
  blocked: false,
};

/**
 * Transfers user data (watch statuses, history, ratings, reactions, character votes,
 * comments) between episode structures when a show's episodes are replaced — either
 * after a TMDB→TVDB structure switch (remapShow) or when splitting a cross-type
 * contaminated record into two entities (remapEpisodesToMedia).
 *
 * Matching is conservative. Titles are never identity proof because providers may use
 * different locales or editorial wording. Ambiguous or unmatched rows are KEPT (never
 * lose watch data) and reported.
 */
@Injectable()
export class StructureRemapService {
  private readonly logger = new Logger(StructureRemapService.name);

  /**
   * Matching-ladder version. v1 = exact airDate / exact slugified title only — it could
   * never map a flattened TMDB structure onto a split TVDB one (TMDB S1E32 ↔ TVDB S2E1
   * share neither a reliable 1986 airDate nor a title). v2 adds absoluteNumber matching.
   * v3 verifies a foreign TVDB episode under the canonical show's TVDB identity. v4
   * ranks same-day release groups by verified aired order, provider coordinates, and
   * supporting title similarity. v5 permits conservative special matching only when a
   * verified date is reinforced by matching S/E coordinates or a strong title. Legacy
   * rows are reconsidered once when this version bump re-arms the repair.
   */
  // v6 re-armed rows quarantined by v5 when TVDB's paginated routing snapshot could
  // silently truncate or swallow throttling. v7 re-arms them after airtime enrichment
  // was made structure-safe and verified dates learned to tolerate UTC/local-day rollover.
  // v8 adds a runtime-verified combined-broadcast → two-part mapping and the strict
  // user-data visibility gate used by general-TV authority migrations. v9 adds the
  // symmetric two-parts → combined-broadcast rule.
  // v10 detects multiple canonical provider ids collapsed onto one row and maps a
  // TMDB special back to a uniquely matching TVDB regular episode by date + title.
  // v11 verifies the losing provider from the same complete comparison snapshot and
  // preserves provider-only S0 user data without letting it veto regular-TV authority.
  // v12 correlates an old ID-less S0 duplicate only when its date, S0 coordinate, normalized
  // title, and runtime all agree with one canonical special (Black Mirror is the regression).
  static readonly MATCHER_VERSION = 12;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly tvdb?: TvdbProvider,
  ) {}

  /**
   * After a canonical-provider snapshot is staged beside a formerly mixed show, identify
   * stale rows that never got linked to the canonical provider (e.g. Re:ZERO TMDB
   * S1E26-77 vs TVDB S2-S4; Dragon Ball's flattened TMDB S1 whose ids were never
   * written; daily shows carrying a stray second provider structure).
   * canonical 'tvdb' (anime / stamped): stale = no TVDB id, fresh = has TVDB id.
   * canonical 'tmdb' (everything else): stale = no TMDB id, fresh = has TMDB id.
   * Maps stale rows onto the fresh ones; dryRun computes matches/counts without writes.
   */
  async remapShow(
    mediaId: string,
    opts?: {
      dryRun?: boolean;
      canonical?: 'tvdb' | 'tmdb';
      reason?: StructureReason;
      onProgress?: (done: number, total: number) => void;
      requireCompleteUserDataMapping?: boolean;
      /** Exact provider ids present in the newly fetched complete snapshot. */
      canonicalValues?: ReadonlySet<string>;
      /** Complete losing-provider graph fetched by the same verified authority decision. */
      foreignSeasons?: NormalizedSeason[];
      /** General-TV ownership compares regular episodes; provider-only S0 is additive. */
      preserveUnmappedSpecials?: boolean;
    },
  ): Promise<RemapStats> {
    const dryRun = opts?.dryRun === true;
    const canonical = opts?.canonical ?? 'tvdb';
    const hasCanonical = (e: EpRow) => {
      const values = canonical === 'tvdb' ? e.tvdbValues : e.tmdbValues;
      if (!opts?.canonicalValues) return values.length > 0;
      // One local row owning two different episodes from the complete canonical
      // snapshot is not fresh. It is a collapsed graph and must be split.
      return values.filter((value) => opts.canonicalValues!.has(value)).length === 1;
    };
    const episodes = await this.loadShowEpisodes(mediaId);
    if (episodes === null) return { ...ZERO, dryRun };

    const stale = episodes.filter(
      (e) => e.structureState === EpisodeStructureState.LEGACY_UNMAPPED || !hasCanonical(e),
    );
    if (stale.length === 0) return { ...ZERO, dryRun };
    const fresh = episodes.filter(
      (e) => e.structureState === EpisodeStructureState.ACTIVE && hasCanonical(e),
    );
    // No canonical rows to map onto — never delete into the void.
    if (fresh.length === 0) return { ...ZERO, dryRun };

    // Rows hydrated before Episode.absoluteNumber existed have it NULL — the matching
    // ladder needs it on BOTH sides. Fill gaps cumulatively from the show's own
    // (possibly stale) ordering: in a flattened TMDB structure S1E32 IS absolute 32,
    // which is exactly the value the TVDB side carries for S2E1. Provider-supplied
    // values are never overwritten; dry-run computes in memory only.
    const activeEpisodes = episodes.filter(
      (episode) => episode.structureState === EpisodeStructureState.ACTIVE,
    );
    if (activeEpisodes.some((e) => e.absoluteNumber == null)) {
      await this.backfillAbsoluteNumbers(activeEpisodes, dryRun);
    }

    this.verifyForeignSnapshot(stale, canonical, opts?.foreignSeasons);
    await this.verifyForeignEpisodeDates(mediaId, canonical, stale);
    if (!dryRun && opts?.requireCompleteUserDataMapping) {
      const preflight = await this.transferMatches(
        stale,
        fresh,
        mediaId,
        true,
        undefined,
        opts.preserveUnmappedSpecials,
      );
      if (preflight.legacyQuarantined > 0) {
        this.logger.warn(
          `remapShow(${mediaId}) blocked: ${preflight.legacyQuarantined} user-data episode(s) have no proven ${canonical.toUpperCase()} target`,
        );
        return {
          ...preflight,
          dryRun: false,
          blocked: true,
          blockedReason: 'UNMAPPED_USER_DATA',
        };
      }
    }
    const stats = await this.transferMatches(
      stale,
      fresh,
      mediaId,
      dryRun,
      opts?.onProgress,
      opts?.preserveUnmappedSpecials,
    );

    // Seasons left empty by the cleanup are not part of the fresh structure — drop them.
    const showId = episodes[0]?.showId;
    if (stats.transferFailed > 0) {
      stats.blocked = true;
      stats.blockedReason = 'TRANSFER_FAILED';
    }
    if (showId && !dryRun && !stats.blocked) {
      const removedSeasons = await this.prisma.season.deleteMany({
        where: { showId, episodes: { none: {} } },
      });
      stats.seasonsRemoved = removedSeasons.count;
      await this.prisma.show.update({
        where: { id: showId },
        data: {
          structureProvider: canonical === 'tvdb' ? StructureProvider.TVDB : StructureProvider.TMDB,
          structureReason:
            opts?.reason ??
            (canonical === 'tvdb' ? StructureReason.ANIME_TVDB : StructureReason.GENERAL_TMDB),
          structureRuleVersion: STRUCTURE_RULE_VERSION,
          structureDecidedAt: new Date(),
        },
      });
    }

    this.logger.log(
      `remapShow(${mediaId})${dryRun ? ' [dry-run]' : ''} [canonical=${canonical}]: ${stats.mapped}/${stats.stale} mapped, ${stats.unmapped} unmapped/kept, ${stats.transferFailed} transfer-failed, ` +
        `${stats.episodesRemoved} episodes + ${stats.seasonsRemoved} seasons removed, ` +
        `${stats.statusesMoved} statuses, ${stats.historiesMoved} history, ${stats.ratingsMoved} ratings, ` +
        `${stats.reactionsMoved} reactions, ${stats.votesMoved} votes, ${stats.commentsMoved} comments, ` +
        `${stats.externalReviewsMoved} external reviews, ${stats.legacyQuarantined} legacy, ${stats.specialsPreserved} supplemental specials preserved, ` +
        `rules=${JSON.stringify(stats.matchRules)}`,
    );
    return stats;
  }

  /**
   * Preview a remap against the same freshly fetched provider snapshot that repair will
   * persist first. A stored-only dry-run can be wrong when the canonical provider has
   * renumbered or corrected episode metadata since the last hydration.
   *
   * Snapshot rows are deliberately synthetic: dry-run matching only needs their
   * provider identity and structural metadata, and never writes the target ids.
   */
  async previewShowAgainstSnapshot(
    mediaId: string,
    canonical: 'tvdb' | 'tmdb',
    seasons: NormalizedSeason[],
    opts?: {
      foreignSeasons?: NormalizedSeason[];
      preserveUnmappedSpecials?: boolean;
    },
  ): Promise<RemapStats> {
    const episodes = await this.loadShowEpisodes(mediaId);
    if (episodes === null) return { ...ZERO, dryRun: true };
    const snapshotValues = new Set(
      seasons.flatMap((season) => season.episodes.map((episode) => String(episode.tmdbId))),
    );
    const hasCanonical = (episode: EpRow) => {
      const values = canonical === 'tvdb' ? episode.tvdbValues : episode.tmdbValues;
      // A single row cannot represent two distinct entries in a complete provider
      // snapshot. Preview it as stale so user-data safety is proven before staging.
      return values.filter((value) => snapshotValues.has(value)).length === 1;
    };
    const stale = episodes.filter(
      (episode) =>
        episode.structureState === EpisodeStructureState.LEGACY_UNMAPPED || !hasCanonical(episode),
    );
    if (stale.length === 0) return { ...ZERO, dryRun: true };

    const fresh: (EpRow & { showId: string })[] = seasons.flatMap((season) =>
      season.episodes.map((episode) => {
        const providerValue = String(episode.tmdbId);
        return {
          id: `preview:${canonical}:${providerValue}`,
          number: episode.number,
          absoluteNumber: episode.absoluteNumber ?? null,
          title: episode.title,
          airDate: episode.airDate ? new Date(episode.airDate) : null,
          runtimeMinutes: episode.runtimeMinutes ?? null,
          seasonId: `preview:${canonical}:season:${season.number}`,
          seasonNumber: season.number,
          isSpecial: season.isSpecial,
          hasTmdb: canonical === 'tmdb',
          hasTvdb: canonical === 'tvdb',
          tmdbValue: canonical === 'tmdb' ? providerValue : null,
          tvdbValue: canonical === 'tvdb' ? providerValue : null,
          tmdbValues: canonical === 'tmdb' ? [providerValue] : [],
          tvdbValues: canonical === 'tvdb' ? [providerValue] : [],
          structureState: EpisodeStructureState.ACTIVE,
          showId: `preview:${mediaId}`,
        };
      }),
    );
    if (fresh.length === 0) return { ...ZERO, stale: stale.length, dryRun: true };

    // Derive missing aired-order values independently for each structure. Combining
    // both graphs would double-count duplicate episodes and shift every later value.
    const activeStale = stale.filter(
      (episode) => episode.structureState === EpisodeStructureState.ACTIVE,
    );
    if (activeStale.some((episode) => episode.absoluteNumber == null)) {
      await this.backfillAbsoluteNumbers(activeStale, true);
    }
    if (fresh.some((episode) => episode.absoluteNumber == null)) {
      await this.backfillAbsoluteNumbers(fresh, true);
    }
    this.verifyForeignSnapshot(stale, canonical, opts?.foreignSeasons);
    await this.verifyForeignEpisodeDates(mediaId, canonical, stale);
    return this.transferMatches(
      stale,
      fresh,
      mediaId,
      true,
      undefined,
      opts?.preserveUnmappedSpecials,
    );
  }

  /**
   * Resolve a batch of TVDB episode ids onto a TMDB-owned show's active episode graph without
   * changing either structure. This is the import-time counterpart of {@link remapShow}: it uses
   * the same conservative matching ladder and one complete TVDB routing snapshot, but performs
   * no transfers, alias moves, structure-state changes, or provider-owner changes.
   *
   * TVDB-owned shows (including ANIME_TVDB and TVDB_ONLY_FALLBACK) deliberately return no bridge:
   * their active TVDB rows are already canonical and must never be routed through TMDB.
   */
  async resolveTvdbEpisodeAliasesToCanonical(
    mediaId: string,
    rawValues: string[],
  ): Promise<CanonicalEpisodeAliasResolution> {
    const empty = (): CanonicalEpisodeAliasResolution => ({
      mappings: new Map<string, string>(),
      verifiedValues: new Set<string>(),
      safeManyToOne: false,
    });
    const requested = new Set(
      rawValues
        .map((value) => value.trim())
        .filter((value) => /^\d+$/.test(value) && Number(value) > 0),
    );
    if (requested.size === 0 || !this.tvdb) return empty();

    const authority = await this.prisma.show.findUnique({
      where: { mediaId },
      select: { structureProvider: true },
    });
    if (authority?.structureProvider !== StructureProvider.TMDB) return empty();

    const episodes = await this.loadShowEpisodes(mediaId);
    if (!episodes?.length) return empty();
    const fresh = episodes.filter(
      (episode) => episode.structureState === EpisodeStructureState.ACTIVE && episode.hasTmdb,
    );
    if (fresh.length === 0) return empty();

    const mappings = new Map<string, string>();
    const verifiedValues = new Set<string>();
    const unresolved = [...requested];

    const tvdbSeries = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const seriesId = Number(tvdbSeries?.value);
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
      return { mappings, verifiedValues, safeManyToOne: false };
    }

    // One complete, paginated snapshot proves both episode identity and parent membership.
    const routing = await this.tvdb.getEpisodeRoutingIndex(seriesId);
    const storedByTvdb = new Map(
      episodes.flatMap((episode) => episode.tvdbValues.map((value) => [value, episode] as const)),
    );
    const candidates: EpRow[] = [];
    for (const value of unresolved) {
      const providerEpisode = routing.get(Number(value));
      if (!providerEpisode) continue;
      verifiedValues.add(value);
      const stored = storedByTvdb.get(value);
      const providerDate = providerEpisode.airDate
        ? new Date(`${providerEpisode.airDate}T00:00:00.000Z`)
        : null;
      const verifiedDate =
        providerDate && !Number.isNaN(providerDate.getTime()) ? providerDate : null;
      const seasonNumber = providerEpisode.seasonNumber ?? stored?.seasonNumber ?? 0;
      const episodeNumber = providerEpisode.episodeNumber ?? stored?.number ?? 0;
      candidates.push({
        id: stored?.id ?? `import-tvdb:${value}`,
        number: episodeNumber,
        absoluteNumber: providerEpisode.absoluteNumber ?? stored?.absoluteNumber ?? null,
        title: stored?.title ?? '',
        airDate: verifiedDate ?? stored?.airDate ?? null,
        seasonId: stored?.seasonId ?? `import-tvdb:season:${seasonNumber}`,
        seasonNumber,
        isSpecial: seasonNumber === 0,
        hasTmdb: false,
        hasTvdb: true,
        tmdbValue: null,
        tvdbValue: value,
        tmdbValues: [],
        tvdbValues: [value],
        structureState: stored?.structureState ?? EpisodeStructureState.LEGACY_UNMAPPED,
        verifiedForeignAirDate: verifiedDate,
        verifiedForeignSeasonNumber: providerEpisode.seasonNumber,
        verifiedForeignEpisodeNumber: providerEpisode.episodeNumber,
        verifiedForeignAbsoluteNumber: providerEpisode.absoluteNumber,
        runtimeMinutes: providerEpisode.runtimeMinutes ?? stored?.runtimeMinutes ?? null,
      });
    }
    if (candidates.length === 0) {
      return { mappings, verifiedValues, safeManyToOne: false };
    }

    // Derive missing canonical absolute numbers in memory only. Import matching must never
    // mutate catalog structure; Metadata Health remains the only repair/write surface.
    if (fresh.some((episode) => episode.absoluteNumber == null)) {
      await this.backfillAbsoluteNumbers(fresh, true);
    }
    // A canonical row that already owns a TVDB alias is occupied. Reusing it for another
    // same-day official episode is safe only when runtime proves that TVDB split one longer
    // TMDB broadcast into parts; this prevents a missing same-day episode (Alert S1E10) from
    // being collapsed onto its distinct neighbour.
    // Existing cross-provider aliases are evidence to revalidate, not an import-time shortcut.
    // Older coordinate-only enrichment could attach a valid TVDB id to the wrong TMDB episode.
    // Remove the foreign alias from the target index so the complete provider snapshot must place
    // every requested id again using structural evidence; this remains entirely read-only.
    const canonicalTargets = fresh.map((episode) => ({
      ...episode,
      tvdbValue: null,
      tvdbValues: [],
    }));
    const occupiedByUnrequestedAlias = fresh
      .filter((episode) => episode.tvdbValues.some((value) => !requested.has(value)))
      .map((episode) => episode.id);
    const { pairs } = this.matchPairs(
      candidates,
      canonicalTargets,
      occupiedByUnrequestedAlias,
      true,
    );
    for (const { from, targets } of pairs) {
      // Import aliases are many source ids → one canonical episode. A one-source →
      // many-target migration is intentionally not collapsed into an arbitrary import id.
      if (from.tvdbValue && targets.length === 1) mappings.set(from.tvdbValue, targets[0].id);
    }

    const sourcesByTarget = new Map<string, EpRow[]>();
    for (const candidate of candidates) {
      if (!candidate.tvdbValue) continue;
      const targetId = mappings.get(candidate.tvdbValue);
      if (!targetId) continue;
      sourcesByTarget.set(targetId, [...(sourcesByTarget.get(targetId) ?? []), candidate]);
    }
    const collapsed = [...sourcesByTarget.entries()].filter(([, sources]) => sources.length > 1);
    const targetById = new Map(fresh.map((episode) => [episode.id, episode]));
    const collapsedTargetsBySeason = new Map<number, number>();
    for (const [targetId] of collapsed) {
      const seasonNumber = targetById.get(targetId)?.seasonNumber;
      if (seasonNumber == null) continue;
      collapsedTargetsBySeason.set(
        seasonNumber,
        (collapsedTargetsBySeason.get(seasonNumber) ?? 0) + 1,
      );
    }
    const tvdbCountBySeason = new Map<number, number>();
    for (const episode of routing.values()) {
      const seasonNumber = episode.seasonNumber;
      const episodeNumber = episode.episodeNumber;
      if (!seasonNumber || seasonNumber <= 0 || !episodeNumber || episodeNumber <= 0) continue;
      tvdbCountBySeason.set(seasonNumber, (tvdbCountBySeason.get(seasonNumber) ?? 0) + 1);
    }
    const tmdbCountBySeason = new Map<number, number>();
    for (const episode of fresh) {
      if (episode.isSpecial || episode.seasonNumber <= 0 || episode.number <= 0) continue;
      tmdbCountBySeason.set(
        episode.seasonNumber,
        (tmdbCountBySeason.get(episode.seasonNumber) ?? 0) + 1,
      );
    }
    const safeManyToOne =
      collapsed.length > 0 &&
      collapsed.every(([targetId, sources]) => {
        const target = targetById.get(targetId);
        if (!target || target.isSpecial || sources.length !== 2) return false;
        if ((collapsedTargetsBySeason.get(target.seasonNumber) ?? 0) !== 1) return false;
        const seasons = new Set(sources.map((source) => source.seasonNumber));
        if (seasons.size !== 1 || !seasons.has(target.seasonNumber)) return false;
        const tvdbCount = tvdbCountBySeason.get(target.seasonNumber) ?? 0;
        const tmdbCount = tmdbCountBySeason.get(target.seasonNumber) ?? 0;
        return tvdbCount > 0 && tmdbCount > 0 && Math.abs(tvdbCount - tmdbCount) < 2;
      });
    return { mappings, verifiedValues, safeManyToOne };
  }

  /**
   * Cross-entity variant: move user data from episodes under one media (e.g. a stray
   * `shows` row contaminating a MOVIE record) onto the episodes of another media (the
   * freshly-created correct show). Every source episode is a remap candidate; matching
   * is the same conservative airDate/title logic. Source rows are deleted once mapped
   * (or when they carry no user data); unmapped rows with user data are KEPT.
   */
  async remapEpisodesToMedia(sourceMediaId: string, targetMediaId: string): Promise<RemapStats> {
    if (sourceMediaId === targetMediaId) return this.remapShow(sourceMediaId);
    const source = await this.loadShowEpisodes(sourceMediaId);
    const target = await this.loadShowEpisodes(targetMediaId);
    if (!source?.length || !target?.length) return { ...ZERO };

    const activeTarget = target.filter(
      (episode) => episode.structureState === EpisodeStructureState.ACTIVE,
    );
    if (activeTarget.length === 0) return { ...ZERO };
    const stats = await this.transferMatches(source, activeTarget, targetMediaId);
    this.logger.log(
      `remapEpisodesToMedia(${sourceMediaId} → ${targetMediaId}): ${stats.mapped}/${stats.stale} mapped, ` +
        `${stats.unmapped} unmapped/kept, ${stats.episodesRemoved} episodes removed`,
    );
    return stats;
  }

  // ---- shared core ----

  /**
   * Fill NULL absoluteNumbers from the show's own season/episode ordering (specials
   * excluded — they don't participate in absolute aired order). Provider-supplied
   * values win; only gaps are filled. Persisted unless dryRun (matching uses the
   * in-memory values either way).
   */
  private async backfillAbsoluteNumbers(
    episodes: (EpRow & { showId: string })[],
    dryRun: boolean,
  ): Promise<void> {
    const regular = episodes
      .filter((e) => !e.isSpecial)
      .sort((a, b) => a.seasonNumber - b.seasonNumber || a.number - b.number);
    let cursor = 1;
    const updates: { id: string; abs: number }[] = [];
    for (const e of regular) {
      if (e.absoluteNumber == null) {
        updates.push({ id: e.id, abs: cursor });
        e.absoluteNumber = cursor;
      }
      cursor++;
    }
    if (dryRun || updates.length === 0) return;
    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.episode.update({
          where: { id: u.id },
          data: { absoluteNumber: u.abs },
        }),
      ),
    );
    this.logger.log(`remap: backfilled absoluteNumber on ${updates.length} episode rows`);
  }

  /** All episodes of a media's shows row (null when the media has no shows row).
   *  Narrow select: only the fields the matcher needs — the default include drags the
   *  fat per-locale JSONB columns (titles/overviews/stillUrls) for every episode into
   *  memory, which is the difference between ~3MB and hundreds of MB on mega-dailies. */
  private async loadShowEpisodes(mediaId: string): Promise<(EpRow & { showId: string })[] | null> {
    const show = await this.prisma.show.findUnique({
      where: { mediaId },
      select: {
        id: true,
        seasons: {
          orderBy: { number: 'asc' },
          select: {
            id: true,
            number: true,
            isSpecial: true,
            episodes: {
              orderBy: { number: 'asc' },
              select: {
                id: true,
                number: true,
                absoluteNumber: true,
                title: true,
                airDate: true,
                runtimeMinutes: true,
                structureState: true,
                externalIds: { select: { provider: true, value: true } },
              },
            },
          },
        },
      },
    });
    if (!show) return null;
    const rows: (EpRow & { showId: string })[] = [];
    for (const s of show.seasons) {
      for (const e of s.episodes) {
        const providers = new Set(e.externalIds.map((x) => x.provider));
        const tmdbValues = e.externalIds
          .filter((x) => x.provider === ExternalProvider.TMDB)
          .map((x) => x.value);
        const tvdbValues = e.externalIds
          .filter((x) => x.provider === ExternalProvider.THE_TVDB)
          .map((x) => x.value);
        rows.push({
          id: e.id,
          number: e.number,
          absoluteNumber: e.absoluteNumber,
          title: e.title,
          airDate: e.airDate,
          runtimeMinutes: e.runtimeMinutes,
          seasonId: s.id,
          seasonNumber: s.number,
          isSpecial: s.isSpecial,
          hasTmdb: providers.has(ExternalProvider.TMDB),
          hasTvdb: providers.has(ExternalProvider.THE_TVDB),
          tmdbValue: tmdbValues[0] ?? null,
          tvdbValue: tvdbValues[0] ?? null,
          tmdbValues,
          tvdbValues,
          structureState: e.structureState,
          showId: show.id,
        });
      }
    }
    return rows;
  }

  /**
   * Replace an untrusted stored date with a provider-verified date for matching only.
   * Looking the episode up inside the show's verified TVDB series snapshot proves both
   * the episode identity and canonical-show membership. Verification is fail-closed:
   * without a complete provider snapshot, remapping aborts before transferring or
   * quarantining anything and the show remains eligible for a later retry.
   */
  private async verifyForeignEpisodeDates(
    mediaId: string,
    canonical: 'tvdb' | 'tmdb',
    stale: EpRow[],
  ): Promise<void> {
    if (canonical !== 'tmdb' || !this.tvdb || !stale.some((episode) => episode.tvdbValue)) {
      return;
    }
    const tvdbSeries = await this.prisma.externalId.findFirst({
      where: {
        mediaId,
        provider: ExternalProvider.THE_TVDB,
        providerEntityKind: ProviderEntityKind.SERIES,
      },
      select: { value: true },
    });
    const seriesId = Number(tvdbSeries?.value);
    if (!Number.isSafeInteger(seriesId) || seriesId <= 0) {
      throw new Error(`Cannot verify TVDB episode aliases for media ${mediaId}: series id missing`);
    }

    const verified = await this.tvdb.getEpisodeRoutingIndex(seriesId);
    for (const episode of stale) {
      const episodeId = Number(episode.tvdbValue);
      if (!Number.isSafeInteger(episodeId) || episodeId <= 0) continue;
      const providerEpisode = verified.get(episodeId);
      if (!providerEpisode) continue;
      episode.verifiedForeignSeasonNumber = providerEpisode.seasonNumber;
      episode.verifiedForeignEpisodeNumber = providerEpisode.episodeNumber;
      episode.verifiedForeignAbsoluteNumber = providerEpisode.absoluteNumber;
      if (providerEpisode.airDate) {
        const date = new Date(`${providerEpisode.airDate}T00:00:00.000Z`);
        if (!Number.isNaN(date.getTime())) episode.verifiedForeignAirDate = date;
      }
    }
  }

  /**
   * The authority comparison already fetched both complete, identity-verified provider
   * graphs. Reuse the losing graph to verify the stored source episode ids in memory.
   * This is especially important for S0: stored dates/titles alone are deliberately too
   * weak, while an exact provider id inside the verified series makes date + title safe.
   */
  private verifyForeignSnapshot(
    stale: EpRow[],
    canonical: 'tvdb' | 'tmdb',
    seasons?: NormalizedSeason[],
  ): void {
    if (!seasons?.length) return;
    const byValue = new Map<
      string,
      {
        seasonNumber: number;
        episodeNumber: number;
        absoluteNumber: number | null;
        airDate: Date | null;
      }
    >();
    for (const season of seasons) {
      for (const episode of season.episodes) {
        const value = String(episode.tmdbId);
        if (!value || value === '0' || byValue.has(value)) continue;
        const parsedAirDate = episode.airDate ? new Date(episode.airDate) : null;
        byValue.set(value, {
          seasonNumber: season.number,
          episodeNumber: episode.number,
          absoluteNumber: episode.absoluteNumber ?? null,
          airDate: parsedAirDate && !Number.isNaN(parsedAirDate.getTime()) ? parsedAirDate : null,
        });
      }
    }

    for (const episode of stale) {
      const values = canonical === 'tvdb' ? episode.tmdbValues : episode.tvdbValues;
      const verified = values
        .map((value) => byValue.get(value))
        .filter((value): value is NonNullable<typeof value> => value !== undefined);
      if (verified.length !== 1) continue;
      episode.verifiedForeignSeasonNumber = verified[0].seasonNumber;
      episode.verifiedForeignEpisodeNumber = verified[0].episodeNumber;
      episode.verifiedForeignAbsoluteNumber = verified[0].absoluteNumber;
      episode.verifiedForeignAirDate = verified[0].airDate;
    }
  }

  /** Match stale→fresh, transfer user data per pair, clean up unmapped rows, and
   *  recompute progress caches on the target show for every affected user.
   *  dryRun computes matches and kept/deleted counts without any writes.
   *  onProgress fires every 25 pairs (long remaps of mega shows would otherwise look
   *  stalled to the repair-progress watcher). */
  private async transferMatches(
    stale: EpRow[],
    fresh: EpRow[],
    targetMediaId: string,
    dryRun = false,
    onProgress?: (done: number, total: number) => void,
    preserveUnmappedSpecials = false,
  ): Promise<RemapStats> {
    const stats: RemapStats = { ...ZERO, stale: stale.length, matchRules: {}, dryRun };
    // A data-free duplicate must never claim the only canonical target before an older
    // row that carries history, ratings, or comments. This can happen while recovering
    // a graph left by an interrupted staging run. Classify once, preserve stable order
    // within each group, and let protected rows claim targets first.
    const { withData } = await this.splitByUserData(stale.map((episode) => episode.id));
    const orderedStale = [...stale].sort(
      (a, b) => Number(withData.has(b.id)) - Number(withData.has(a.id)),
    );
    const { pairs, unmapped, matchRules } = this.matchPairs(orderedStale, fresh);
    stats.matchRules = matchRules;

    if (dryRun) {
      // Counts mirror the real run's decisions: mapped pairs, and among unmapped rows
      // how many would be KEPT (user data) vs deleted.
      stats.mapped = pairs.length;
      const unmappedWithData = unmapped.filter((episode) => withData.has(episode.id)).length;
      const preservedSpecials = preserveUnmappedSpecials
        ? unmapped.filter(
            (episode) =>
              episode.isSpecial &&
              episode.structureState === EpisodeStructureState.ACTIVE &&
              withData.has(episode.id),
          ).length
        : 0;
      stats.unmapped = unmappedWithData;
      stats.specialsPreserved = preservedSpecials;
      stats.legacyQuarantined = unmappedWithData - preservedSpecials;
      stats.episodesRemoved = unmapped.length - unmappedWithData;
      return stats;
    }

    const affectedUsers = new Set<string>();
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i];
      try {
        const moved =
          p.targets.length === 1
            ? await this.transferPair(p.from, p.targets[0], affectedUsers)
            : await this.transferSplit(p.from, p.targets, affectedUsers);
        stats.mapped++;
        stats.statusesMoved += moved.statuses;
        stats.historiesMoved += moved.histories;
        stats.ratingsMoved += moved.ratings;
        stats.reactionsMoved += moved.reactions;
        stats.votesMoved += moved.votes;
        stats.commentsMoved += moved.comments;
        stats.externalReviewsMoved += moved.externalReviews;
        stats.episodesRemoved++;
      } catch (e) {
        // Keep both rows on failure — data loss is worse than a stale episode row.
        // Counted separately from `unmapped` so the convergence stamps do NOT park
        // this row: it stays stale and is retried on the next run.
        stats.transferFailed++;
        this.logger.warn(
          `remap transfer failed for episode ${p.from.id} → ${p.targets.map((target) => target.id).join(',')}: ${(e as Error).message}`,
        );
      }
      if (onProgress && (i + 1) % 25 === 0) onProgress(i + 1, pairs.length);
    }
    // Final heartbeat: totals rarely divide by 25, so without this the UI sits on the
    // last partial beat (e.g. 75/89) through the whole cleanup phase below.
    if (onProgress && pairs.length > 0) onProgress(pairs.length, pairs.length);

    // Unmapped rows: delete only when they carry NO user data; keep (and report) the
    // rest. Batched — one EXISTS query classifies every row, one deleteMany clears
    // the dataless ones. The old per-row hasUserData+delete issued ~6 queries per
    // row, which is tens of thousands on mega-dailies whose structures barely
    // overlap (Charlie Rose: ~5,800 unmapped) and dominated the per-show runtime.
    const keptLabels: string[] = [];
    const preservedLabels: string[] = [];
    const legacyIds: string[] = [];
    const deleteIds: string[] = [];
    for (const s of unmapped) {
      if (withData.has(s.id)) {
        stats.unmapped++;
        if (
          preserveUnmappedSpecials &&
          s.isSpecial &&
          s.structureState === EpisodeStructureState.ACTIVE
        ) {
          stats.specialsPreserved++;
          preservedLabels.push(`S${s.seasonNumber}E${s.number}`);
          continue;
        }
        stats.legacyQuarantined++;
        legacyIds.push(s.id);
        keptLabels.push(`S${s.seasonNumber}E${s.number}`);
      } else {
        deleteIds.push(s.id);
      }
    }
    if (legacyIds.length > 0) {
      await this.prisma.episode.updateMany({
        where: { id: { in: legacyIds } },
        data: { structureState: EpisodeStructureState.LEGACY_UNMAPPED },
      });
    }
    if (deleteIds.length > 0) {
      try {
        const removed = await this.prisma.episode.deleteMany({ where: { id: { in: deleteIds } } });
        stats.episodesRemoved += removed.count;
      } catch (e) {
        // Conservative: on cleanup failure keep the rows (counted as unmapped, retried
        // next run) — data loss is worse than a stale episode row.
        stats.unmapped += deleteIds.length;
        this.logger.warn(`remap: batched stale-episode cleanup failed: ${(e as Error).message}`);
      }
    }
    // One aggregated line instead of a warning per kept episode (long-running shows can
    // keep dozens — per-row logs flood the API log on every re-run).
    if (keptLabels.length > 0) {
      const preview = keptLabels.slice(0, 8).join(', ');
      const more = keptLabels.length > 8 ? `, … +${keptLabels.length - 8} more` : '';
      this.logger.warn(
        `remap: kept ${keptLabels.length} unmapped episodes with user data (${preview}${more})`,
      );
    }
    if (preservedLabels.length > 0) {
      const preview = preservedLabels.slice(0, 8).join(', ');
      const more = preservedLabels.length > 8 ? `, … +${preservedLabels.length - 8} more` : '';
      this.logger.log(
        `remap: preserved ${preservedLabels.length} provider-only supplemental specials with user data (${preview}${more})`,
      );
    }

    // Recompute per-user progress caches for everyone touched.
    for (const userId of affectedUsers) {
      await this.recomputeUserShowStatus(userId, targetMediaId).catch((e) =>
        this.logger.debug(`recompute userShowStatus failed for ${userId}: ${(e as Error).message}`),
      );
      if (this.redis) {
        await Promise.all([
          this.redis.delByPattern(`watchnext:${userId}:*`),
          this.redis.delByPattern(`upcoming:${userId}:*`),
          this.redis.delByPattern(`showsprogress:${userId}:*`),
        ]).catch((e) =>
          this.logger.debug(`cache invalidation failed for ${userId}: ${(e as Error).message}`),
        );
      }
    }
    return stats;
  }

  /** Build conservative stale→canonical pairs without reading or writing user data. */
  private matchPairs(
    stale: EpRow[],
    fresh: EpRow[],
    initiallyClaimed: Iterable<string> = [],
    requireRuntimeForClaimedDateReuse = false,
  ): {
    pairs: EpisodeMatch[];
    unmapped: EpRow[];
    matchRules: Record<string, number>;
  } {
    const claimed = new Set<string>(initiallyClaimed);
    const byDate = new Map<string, EpRow[]>();
    const byAbsolute = new Map<number, EpRow[]>();
    const byTmdb = new Map<string, EpRow[]>();
    const byTvdb = new Map<string, EpRow[]>();
    for (const f of fresh) {
      if (f.airDate) {
        const k = f.airDate.toISOString().slice(0, 10);
        byDate.set(k, [...(byDate.get(k) ?? []), f]);
      }
      if (f.absoluteNumber != null) {
        byAbsolute.set(f.absoluteNumber, [...(byAbsolute.get(f.absoluteNumber) ?? []), f]);
      }
      if (f.tmdbValue) byTmdb.set(f.tmdbValue, [...(byTmdb.get(f.tmdbValue) ?? []), f]);
      if (f.tvdbValue) byTvdb.set(f.tvdbValue, [...(byTvdb.get(f.tvdbValue) ?? []), f]);
    }

    const pairs: EpisodeMatch[] = [];
    const unmapped: EpRow[] = [];
    const matchRules: Record<string, number> = {};
    const combinedGroups = this.matchCombinedSourceGroups(stale, fresh);
    const combinedClaims = new Map<string, string>();
    for (const s of stale) {
      const match = this.matchTarget(
        s,
        byDate,
        byAbsolute,
        byTmdb,
        byTvdb,
        claimed,
        requireRuntimeForClaimedDateReuse,
      );
      // Exact external identity is always strongest. Before accepting weaker one-to-one
      // order/date evidence, check whether runtime proves that this source is the parent
      // combined broadcast of two official target parts, or one of two source parts
      // represented by a single official target broadcast.
      const split = match?.rule === 'externalId' ? null : this.matchSplitTargets(s, fresh, claimed);
      const combined = match?.rule === 'externalId' || split ? null : combinedGroups.get(s.id);
      if (split) {
        for (const target of split.targets) claimed.add(target.id);
        pairs.push({ from: s, targets: split.targets, rule: split.rule });
        matchRules[split.rule] = (matchRules[split.rule] ?? 0) + 1;
      } else if (
        combined &&
        (!claimed.has(combined.target.id) ||
          combinedClaims.get(combined.target.id) === combined.key)
      ) {
        claimed.add(combined.target.id);
        combinedClaims.set(combined.target.id, combined.key);
        pairs.push({ from: s, targets: [combined.target], rule: combined.rule });
        matchRules[combined.rule] = (matchRules[combined.rule] ?? 0) + 1;
      } else if (match) {
        claimed.add(match.to.id);
        pairs.push({ from: s, targets: [match.to], rule: match.rule });
        matchRules[match.rule] = (matchRules[match.rule] ?? 0) + 1;
      } else {
        unmapped.push(s);
      }
    }
    return { pairs, unmapped, matchRules };
  }

  /**
   * High-confidence two-to-one mapping for providers that expose two short parts where
   * the official target graph has one combined broadcast. The whole same-day group must
   * be exactly two contiguous source rows and one target row, and runtimes must reconcile.
   * Any source with an exact target external id is excluded so provider identity wins.
   */
  private matchCombinedSourceGroups(
    stale: EpRow[],
    fresh: EpRow[],
  ): Map<string, { target: EpRow; key: string; rule: string }> {
    const result = new Map<string, { target: EpRow; key: string; rule: string }>();
    const dayOf = (episode: EpRow) =>
      (episode.verifiedForeignAirDate ?? episode.airDate)?.toISOString().slice(0, 10) ?? null;
    const staleByDay = new Map<string, EpRow[]>();
    const freshByDay = new Map<string, EpRow[]>();
    for (const source of stale) {
      const day = dayOf(source);
      if (!source.isSpecial && day) staleByDay.set(day, [...(staleByDay.get(day) ?? []), source]);
    }
    for (const target of fresh) {
      const day = dayOf(target);
      if (!target.isSpecial && day) freshByDay.set(day, [...(freshByDay.get(day) ?? []), target]);
    }

    const hasExactTarget = (source: EpRow) =>
      fresh.some(
        (target) =>
          source.tmdbValues.some((value) => target.tmdbValues.includes(value)) ||
          source.tvdbValues.some((value) => target.tvdbValues.includes(value)),
      );
    for (const [day, daySources] of staleByDay) {
      const dayTargets = freshByDay.get(day) ?? [];
      if (daySources.length !== 2 || dayTargets.length !== 1) continue;
      const sources = [...daySources].sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber ||
          a.number - b.number ||
          (a.absoluteNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.absoluteNumber ?? Number.MAX_SAFE_INTEGER),
      );
      const [first, second] = sources;
      const target = dayTargets[0];
      if (hasExactTarget(first) || hasExactTarget(second)) continue;
      if (
        !first.runtimeMinutes ||
        first.runtimeMinutes <= 0 ||
        !second.runtimeMinutes ||
        second.runtimeMinutes <= 0 ||
        !target.runtimeMinutes ||
        target.runtimeMinutes <= 0
      ) {
        continue;
      }
      const contiguousByCoordinate =
        first.seasonNumber === second.seasonNumber && second.number === first.number + 1;
      const contiguousByAbsolute =
        first.absoluteNumber != null &&
        second.absoluteNumber != null &&
        second.absoluteNumber === first.absoluteNumber + 1;
      if (!contiguousByCoordinate && !contiguousByAbsolute) continue;

      const sourceRuntime = first.runtimeMinutes + second.runtimeMinutes;
      const runtimeDelta = Math.abs(sourceRuntime - target.runtimeMinutes) / target.runtimeMinutes;
      const bothAreParts =
        first.runtimeMinutes <= target.runtimeMinutes * 0.75 &&
        second.runtimeMinutes <= target.runtimeMinutes * 0.75;
      if (runtimeDelta > 0.2 || !bothAreParts) continue;

      const key = `${day}:${first.id}:${second.id}:${target.id}`;
      const group = { target, key, rule: 'airDate+partsRuntime' };
      result.set(first.id, group);
      result.set(second.id, group);
    }
    return result;
  }

  /**
   * High-confidence one-to-two mapping for providers that publish one long broadcast
   * as two official parts. Exact external ids still win in {@link matchTarget}; this
   * fallback requires exactly two unclaimed, contiguous, same-day regular episodes and
   * runtimes whose sum closely matches the source runtime.
   */
  private matchSplitTargets(
    source: EpRow,
    fresh: EpRow[],
    claimed: Set<string>,
  ): { targets: [EpRow, EpRow]; rule: string } | null {
    if (
      source.isSpecial ||
      !source.airDate ||
      !source.runtimeMinutes ||
      source.runtimeMinutes <= 0
    ) {
      return null;
    }
    const day = source.airDate.toISOString().slice(0, 10);
    const candidates = fresh
      .filter(
        (target) =>
          !target.isSpecial &&
          !claimed.has(target.id) &&
          !!target.airDate &&
          target.airDate.toISOString().slice(0, 10) === day &&
          !!target.runtimeMinutes &&
          target.runtimeMinutes > 0,
      )
      .sort(
        (a, b) =>
          a.seasonNumber - b.seasonNumber ||
          a.number - b.number ||
          (a.absoluteNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.absoluteNumber ?? Number.MAX_SAFE_INTEGER),
      );
    if (candidates.length !== 2) return null;
    const [first, second] = candidates;
    const contiguousByCoordinate =
      first.seasonNumber === second.seasonNumber && second.number === first.number + 1;
    const contiguousByAbsolute =
      first.absoluteNumber != null &&
      second.absoluteNumber != null &&
      second.absoluteNumber === first.absoluteNumber + 1;
    if (!contiguousByCoordinate && !contiguousByAbsolute) return null;

    const targetRuntime = first.runtimeMinutes! + second.runtimeMinutes!;
    const runtimeDelta = Math.abs(targetRuntime - source.runtimeMinutes) / source.runtimeMinutes;
    const bothAreParts =
      first.runtimeMinutes! <= source.runtimeMinutes * 0.75 &&
      second.runtimeMinutes! <= source.runtimeMinutes * 0.75;
    if (runtimeDelta > 0.2 || !bothAreParts) return null;
    return { targets: [first, second], rule: 'airDate+combinedRuntime' };
  }

  /**
   * Conservative target pick, strongest signal first:
   *  1. provider-verified exact air date within the canonical show. A unique canonical
   *     target may be reused because TVDB can split one TMDB broadcast into two parts.
   *  2. absoluteNumber + airDate (±1 day) — cross-provider proof (0.95).
   *  3. absoluteNumber alone, unique on both sides, airDate missing somewhere (0.9) —
   *     the flattened-TMDB ↔ split-TVDB correspondence (TMDB S1E32 == TVDB S2E1).
   *  4. stored exact airDate, unique. Stored dates are weaker but remain useful when a
   *     foreign provider id is unavailable. Titles never select a target.
   * Anything ambiguous returns null — never guess, the stale row is kept and reported.
   */
  private matchTarget(
    s: EpRow,
    byDate: Map<string, EpRow[]>,
    byAbsolute: Map<number, EpRow[]>,
    byTmdb: Map<string, EpRow[]>,
    byTvdb: Map<string, EpRow[]>,
    claimed: Set<string>,
    requireRuntimeForClaimedDateReuse = false,
  ): { to: EpRow; rule: string } | null {
    const dayOf = (d: Date) => d.toISOString().slice(0, 10);
    const sameDayish = (a: Date | null, b: Date | null) => {
      if (!a || !b) return false;
      const diff = Math.abs(a.getTime() - b.getTime());
      return diff <= 36 * 60 * 60 * 1000; // ±1.5 days absorbs TZ shifts
    };

    const exact = new Map<string, EpRow>();
    for (const value of s.tmdbValues) {
      for (const candidate of byTmdb.get(value) ?? []) exact.set(candidate.id, candidate);
    }
    for (const value of s.tvdbValues) {
      for (const candidate of byTvdb.get(value) ?? []) exact.set(candidate.id, candidate);
    }
    const unclaimedExact = [...exact.values()].filter((candidate) => !claimed.has(candidate.id));
    if (unclaimedExact.length === 1) return { to: unclaimedExact[0], rule: 'externalId' };
    // Specials never use date alone: providers frequently publish several trailers,
    // recaps, and shorts on one day with unrelated numbering. Once the TVDB episode has
    // been verified inside this canonical show, however, exact date + S/E coordinates
    // or exact date + a strong title is enough evidence even when TMDB /find exposes no
    // cross-provider episode id (DuckTales S0E2 is the regression case).
    if (s.isSpecial) {
      if (!s.verifiedForeignAirDate) {
        // Some pre-authority catalogs kept a second, ID-less copy of a shared special. It
        // cannot be verified by provider id, but four independent stored/provider signals
        // make the duplicate unambiguous. Keep this narrower than ordinary special matching:
        // legacy state + exact date + exact S0 coordinate + normalized title + close runtime.
        if (
          s.structureState === EpisodeStructureState.LEGACY_UNMAPPED &&
          s.airDate &&
          s.runtimeMinutes != null &&
          s.runtimeMinutes > 0
        ) {
          const legacyDuplicate = uniqueCandidate(
            byDate.get(dayOf(s.airDate)) ?? [],
            (candidate) =>
              candidate.isSpecial &&
              !claimed.has(candidate.id) &&
              candidate.seasonNumber === 0 &&
              candidate.number === s.number &&
              candidate.runtimeMinutes != null &&
              candidate.runtimeMinutes > 0 &&
              Math.abs(candidate.runtimeMinutes - s.runtimeMinutes!) <=
                Math.max(5, s.runtimeMinutes! * 0.1) &&
              supportingTitleSimilarity(s.title, candidate.title) === 1,
          );
          if (legacyDuplicate) {
            return {
              to: legacyDuplicate,
              rule: 'legacySpecialDate+seasonEpisode+title+runtime',
            };
          }
        }

        // TMDB sometimes parks unaired regular episodes in S0 while TVDB keeps them in
        // the official season (Eastwick is the regression case). Date alone remains
        // forbidden; an exact-day, uniquely strongest title match may cross only from
        // a stored special to a regular canonical episode.
        if (!s.airDate) return null;
        const crossOrder = (byDate.get(dayOf(s.airDate)) ?? [])
          .filter((candidate) => !candidate.isSpecial && !claimed.has(candidate.id))
          .map((candidate) => ({
            candidate,
            score: supportingTitleSimilarity(s.title, candidate.title),
          }))
          .filter((entry) => entry.score >= 0.8)
          .sort((a, b) => b.score - a.score);
        if (
          crossOrder.length > 0 &&
          (crossOrder.length === 1 || crossOrder[0].score > crossOrder[1].score)
        ) {
          return { to: crossOrder[0].candidate, rule: 'specialDate+titleCrossOrder' };
        }
        return null;
      }
      const candidates = (byDate.get(dayOf(s.verifiedForeignAirDate)) ?? []).filter(
        (candidate) => candidate.isSpecial && !claimed.has(candidate.id),
      );
      const byProviderCoordinates = uniqueCandidate(
        candidates,
        (candidate) =>
          s.verifiedForeignSeasonNumber === 0 &&
          s.verifiedForeignEpisodeNumber != null &&
          candidate.seasonNumber === 0 &&
          candidate.number === s.verifiedForeignEpisodeNumber,
      );
      if (byProviderCoordinates) {
        return { to: byProviderCoordinates, rule: 'verifiedSpecialDate+seasonEpisode' };
      }

      const titleRanked = candidates
        .map((candidate) => ({
          candidate,
          score: supportingTitleSimilarity(s.title, candidate.title),
        }))
        .filter((entry) => entry.score >= 0.8)
        .sort((a, b) => b.score - a.score);
      if (
        titleRanked.length > 0 &&
        (titleRanked.length === 1 || titleRanked[0].score > titleRanked[1].score)
      ) {
        return { to: titleRanked[0].candidate, rule: 'verifiedSpecialDate+title' };
      }
      return null;
    }

    if (s.verifiedForeignAirDate) {
      let candidates = byDate.get(dayOf(s.verifiedForeignAirDate)) ?? [];
      if (candidates.length === 0) {
        // Canonical metadata stores provider dates at midnight, while TVmaze enrichment stores
        // an airstamp. A late North-American broadcast therefore lands on the following UTC
        // date even though both providers describe the same local broadcast day. Keep the
        // tolerance bounded and require one unique canonical row inside the window.
        const adjacent = new Map<string, EpRow>();
        for (const offset of [-1, 1]) {
          const date = new Date(s.verifiedForeignAirDate.getTime() + offset * 24 * 60 * 60 * 1000);
          for (const candidate of byDate.get(dayOf(date)) ?? []) {
            if (sameDayish(s.verifiedForeignAirDate, candidate.airDate)) {
              adjacent.set(candidate.id, candidate);
            }
          }
        }
        candidates = [...adjacent.values()];
      }
      // Do not filter `claimed`: multiple verified TVDB parts may represent one combined
      // TMDB episode. The exact date must still identify one and only one canonical row.
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (requireRuntimeForClaimedDateReuse && claimed.has(candidate.id)) {
          const sourceRuntime = s.runtimeMinutes ?? null;
          const targetRuntime = candidate.runtimeMinutes ?? null;
          const isPlausibleSplit =
            sourceRuntime != null &&
            sourceRuntime > 0 &&
            targetRuntime != null &&
            targetRuntime > 0 &&
            sourceRuntime * 1.5 <= targetRuntime;
          if (!isPlausibleSplit) return null;
        }
        return { to: candidate, rule: 'verifiedProviderAirDate' };
      }
      if (candidates.length > 1) {
        const unclaimed = candidates.filter((candidate) => !claimed.has(candidate.id));

        const byVerifiedAbsolute = uniqueCandidate(
          unclaimed,
          (candidate) =>
            s.verifiedForeignAbsoluteNumber != null &&
            candidate.absoluteNumber === s.verifiedForeignAbsoluteNumber,
        );
        if (byVerifiedAbsolute) {
          return { to: byVerifiedAbsolute, rule: 'verifiedDate+absolute' };
        }

        const byProviderCoordinates = uniqueCandidate(
          unclaimed,
          (candidate) =>
            s.verifiedForeignSeasonNumber != null &&
            s.verifiedForeignEpisodeNumber != null &&
            candidate.seasonNumber === s.verifiedForeignSeasonNumber &&
            candidate.number === s.verifiedForeignEpisodeNumber,
        );
        if (byProviderCoordinates) {
          return { to: byProviderCoordinates, rule: 'verifiedDate+seasonEpisode' };
        }

        const titleRanked = unclaimed
          .map((candidate) => ({
            candidate,
            score: supportingTitleSimilarity(s.title, candidate.title),
          }))
          .filter((entry) => entry.score >= 0.6)
          .sort((a, b) => b.score - a.score);
        if (
          titleRanked.length > 0 &&
          (titleRanked.length === 1 || titleRanked[0].score > titleRanked[1].score)
        ) {
          return { to: titleRanked[0].candidate, rule: 'verifiedDate+title' };
        }
      }
    }

    if (s.absoluteNumber != null) {
      const candidates = (byAbsolute.get(s.absoluteNumber) ?? []).filter((f) => !claimed.has(f.id));
      if (candidates.length === 1) {
        const c = candidates[0];
        if (s.airDate && c.airDate && sameDayish(s.airDate, c.airDate)) {
          return { to: c, rule: 'absolute+date' };
        }
        // A UNIQUE absolute-number correspondence is proof on its own: both structures
        // are aired-order, and real provider data shows airDates routinely disagree by
        // months for the same episode (Dragon Ball 1986). Dates can only VETO via
        // duplicate absolutes below, not block a unique match.
        return { to: c, rule: 'absolute' };
      }
      if (candidates.length > 1) {
        const dated = candidates.filter((f) => sameDayish(s.airDate, f.airDate));
        if (dated.length === 1) return { to: dated[0], rule: 'absolute+date' };
        return null; // duplicate absolute numbers on the fresh side — do not guess
      }
    }

    if (s.airDate) {
      const candidates = (byDate.get(dayOf(s.airDate)) ?? []).filter((f) => !claimed.has(f.id));
      if (candidates.length === 1) return { to: candidates[0], rule: 'airDate' };
      if (candidates.length > 1) return null; // ambiguous airDate group — do not guess
    }
    return null;
  }

  /** Move all per-episode user data from the stale row to the fresh one, then delete it. */
  private async transferPair(
    from: EpRow,
    to: EpRow,
    affectedUsers: Set<string>,
  ): Promise<TransferredUserData> {
    return this.prisma.$transaction(
      (tx) => this.transferPairInTransaction(tx, from, to, affectedUsers),
      { timeout: 30000 },
    );
  }

  /**
   * One combined source episode became two official parts. Copy episode-scoped user
   * choices and history to the secondary target, then perform the normal move to the
   * primary target inside the same transaction. The current comment tree is cloned once
   * onto the secondary episode; both threads are completely independent afterwards.
   */
  private async transferSplit(
    from: EpRow,
    targets: EpRow[],
    affectedUsers: Set<string>,
  ): Promise<TransferredUserData> {
    if (targets.length !== 2) throw new Error('Split transfer requires exactly two targets');
    const [primary, secondary] = targets;
    return this.prisma.$transaction(
      async (tx) => {
        const copied = await this.copyUserDataToTarget(tx, from, secondary, affectedUsers);
        const moved = await this.transferPairInTransaction(tx, from, primary, affectedUsers);
        return {
          statuses: moved.statuses + copied.statuses,
          histories: moved.histories + copied.histories,
          ratings: moved.ratings + copied.ratings,
          reactions: moved.reactions + copied.reactions,
          votes: moved.votes + copied.votes,
          comments: moved.comments + copied.comments,
          externalReviews: moved.externalReviews,
        };
      },
      { timeout: 30000 },
    );
  }

  /** Clone the current user-comment snapshot for a split episode. New ids are allocated
   * for the full reply tree, likes, spoiler reports, and ready image rows. Image blobs are
   * immutable and may be referenced by both rows; deletion keeps the blob while another
   * live CommentImage still references its storage key. Provider reviews/moderation cases
   * are not duplicated. */
  private async cloneCommentThread(
    tx: Prisma.TransactionClient,
    sourceThreadId: string,
    targetThreadId: string,
  ): Promise<number> {
    const sourceComments = await tx.comment.findMany({
      where: { threadType: 'EPISODE', threadId: sourceThreadId },
      orderBy: [{ depth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: { likes: true, spoilerReports: true, image: true },
    });
    const clonedIds = new Map<string, string>();
    for (const source of sourceComments) {
      const clonedParentId = source.parentId ? clonedIds.get(source.parentId) : null;
      const clonedRootId = source.rootId ? clonedIds.get(source.rootId) : null;
      if (source.parentId && !clonedParentId) {
        throw new Error(`Cannot clone comment ${source.id}: parent is outside the source thread`);
      }
      if (source.rootId && !clonedRootId) {
        throw new Error(`Cannot clone comment ${source.id}: root is outside the source thread`);
      }
      const cloned = await tx.comment.create({
        data: {
          userId: source.userId,
          parentId: clonedParentId,
          depth: source.depth,
          rootId: clonedRootId,
          threadType: source.threadType,
          threadId: targetThreadId,
          body: source.body,
          imageUrl: source.imageUrl,
          gifUrl: source.gifUrl,
          mediaType: source.mediaType,
          mediaId: source.mediaId,
          listId: source.listId,
          isSpoiler: source.isSpoiler,
          spoilerCount: source.spoilerCount,
          // Provider reviews themselves are not cloneable (provider ids are globally
          // unique). A user reply to one becomes an ordinary independent comment on
          // the secondary part so its content is still visible there.
          externalReviewId: null,
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
        select: { id: true },
      });
      clonedIds.set(source.id, cloned.id);

      if (source.likes.length > 0) {
        await tx.commentLike.createMany({
          data: source.likes.map((like) => ({
            userId: like.userId,
            commentId: cloned.id,
            createdAt: like.createdAt,
          })),
        });
      }
      if (source.spoilerReports.length > 0) {
        await tx.commentSpoilerReport.createMany({
          data: source.spoilerReports.map((report) => ({
            userId: report.userId,
            commentId: cloned.id,
            createdAt: report.createdAt,
          })),
        });
      }
      if (source.image?.status === 'ready') {
        await tx.commentImage.create({
          data: {
            commentId: cloned.id,
            userId: source.image.userId,
            status: source.image.status,
            originalMimeType: source.image.originalMimeType,
            detectedMimeType: source.image.detectedMimeType,
            originalSizeBytes: source.image.originalSizeBytes,
            uploadedSizeBytes: source.image.uploadedSizeBytes,
            processedSizeBytes: source.image.processedSizeBytes,
            thumbnailSizeBytes: source.image.thumbnailSizeBytes,
            width: source.image.width,
            height: source.image.height,
            thumbnailWidth: source.image.thumbnailWidth,
            thumbnailHeight: source.image.thumbnailHeight,
            storageKey: source.image.storageKey,
            thumbnailStorageKey: source.image.thumbnailStorageKey,
            tempStorageKey: null,
            encryptionAlgorithm: source.image.encryptionAlgorithm,
            encryptedDataKey: source.image.encryptedDataKey,
            iv: source.image.iv,
            authTag: source.image.authTag,
            thumbnailEncryptedDataKey: source.image.thumbnailEncryptedDataKey,
            thumbnailIv: source.image.thumbnailIv,
            thumbnailAuthTag: source.image.thumbnailAuthTag,
            sha256Hash: source.image.sha256Hash,
            blurhash: source.image.blurhash,
            moderationProvider: source.image.moderationProvider,
            moderationModel: source.image.moderationModel,
            moderationFlagged: source.image.moderationFlagged,
            moderationCategories:
              source.image.moderationCategories === null
                ? Prisma.JsonNull
                : (source.image.moderationCategories as Prisma.InputJsonValue),
            moderationCategoryScores:
              source.image.moderationCategoryScores === null
                ? Prisma.JsonNull
                : (source.image.moderationCategoryScores as Prisma.InputJsonValue),
            moderationDecision: source.image.moderationDecision,
            rejectionReason: source.image.rejectionReason,
            errorMessage: source.image.errorMessage,
            createdAt: source.image.createdAt,
            updatedAt: source.image.updatedAt,
            processedAt: source.image.processedAt,
            deletedAt: null,
          },
        });
      }
    }
    return sourceComments.length;
  }

  private async copyUserDataToTarget(
    tx: Prisma.TransactionClient,
    from: EpRow,
    to: EpRow,
    affectedUsers: Set<string>,
  ): Promise<Omit<TransferredUserData, 'externalReviews'>> {
    let statuses = 0;
    for (const status of await tx.userEpisodeStatus.findMany({
      where: { episodeId: from.id },
    })) {
      affectedUsers.add(status.userId);
      const existing = await tx.userEpisodeStatus.findUnique({
        where: { userId_episodeId: { userId: status.userId, episodeId: to.id } },
      });
      if (existing) {
        const watchedAt = [existing.watchedAt, status.watchedAt]
          .filter((value): value is Date => !!value)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        await tx.userEpisodeStatus.update({
          where: { id: existing.id },
          data: {
            watched: existing.watched || status.watched,
            watchedAt: watchedAt ?? null,
            watchCount: Math.max(existing.watchCount, status.watchCount),
            device: existing.device ?? status.device,
          },
        });
      } else {
        await tx.userEpisodeStatus.create({
          data: {
            userId: status.userId,
            episodeId: to.id,
            watched: status.watched,
            watchedAt: status.watchedAt,
            watchCount: status.watchCount,
            device: status.device,
            createdAt: status.createdAt,
          },
        });
      }
      statuses++;
    }

    const sourceHistories = await tx.watchHistory.findMany({ where: { episodeId: from.id } });
    if (sourceHistories.length > 0) {
      await tx.watchHistory.createMany({
        data: sourceHistories.map((history) => ({
          userId: history.userId,
          mediaId: history.mediaId,
          mediaType: history.mediaType,
          episodeId: to.id,
          seasonNumber: to.seasonNumber,
          episodeNumber: to.number,
          runtimeMinutes: history.runtimeMinutes,
          watchedAt: history.watchedAt,
          createdAt: history.createdAt,
        })),
      });
      for (const history of sourceHistories) affectedUsers.add(history.userId);
    }

    let ratings = 0;
    for (const rating of await tx.rating.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(rating.userId);
      const existing = await tx.rating.findFirst({
        where: { userId: rating.userId, episodeId: to.id },
      });
      if (existing) {
        if (preferSourceChoice(rating, existing)) {
          await tx.rating.update({
            where: { id: existing.id },
            data: { rating: rating.rating, source: rating.source, sourceKey: rating.sourceKey },
          });
        }
      } else {
        await tx.rating.create({
          data: {
            userId: rating.userId,
            episodeId: to.id,
            rating: rating.rating,
            source: rating.source,
            sourceKey: rating.sourceKey,
            createdAt: rating.createdAt,
          },
        });
      }
      ratings++;
    }

    let reactions = 0;
    for (const reaction of await tx.reaction.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(reaction.userId);
      const existing = await tx.reaction.findFirst({
        where: { userId: reaction.userId, episodeId: to.id, reaction: reaction.reaction },
      });
      if (existing) {
        if (preferSourceChoice(reaction, existing)) {
          await tx.reaction.update({
            where: { id: existing.id },
            data: {
              source: reaction.source,
              sourceKey: reaction.sourceKey,
              updatedAt: reaction.updatedAt,
            },
          });
        }
      } else {
        await tx.reaction.create({
          data: {
            userId: reaction.userId,
            episodeId: to.id,
            reaction: reaction.reaction,
            source: reaction.source,
            sourceKey: reaction.sourceKey,
            createdAt: reaction.createdAt,
            updatedAt: reaction.updatedAt,
          },
        });
      }
      reactions++;
    }

    let votes = 0;
    for (const vote of await tx.characterVote.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(vote.userId);
      const existing = await tx.characterVote.findFirst({
        where: { userId: vote.userId, episodeId: to.id },
      });
      if (existing) {
        if (preferSourceChoice(vote, existing)) {
          await tx.characterVote.update({
            where: { id: existing.id },
            data: { castId: vote.castId, source: vote.source, sourceKey: vote.sourceKey },
          });
        }
      } else {
        await tx.characterVote.create({
          data: {
            userId: vote.userId,
            episodeId: to.id,
            castId: vote.castId,
            source: vote.source,
            sourceKey: vote.sourceKey,
            createdAt: vote.createdAt,
          },
        });
      }
      votes++;
    }

    const comments = await this.cloneCommentThread(tx, from.id, to.id);
    return {
      statuses,
      histories: sourceHistories.length,
      ratings,
      reactions,
      votes,
      comments,
    };
  }

  private async transferPairInTransaction(
    tx: Prisma.TransactionClient,
    from: EpRow,
    to: EpRow,
    affectedUsers: Set<string>,
  ): Promise<TransferredUserData> {
    let statuses = 0;
    for (const s of await tx.userEpisodeStatus.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(s.userId);
      const existing = await tx.userEpisodeStatus.findUnique({
        where: { userId_episodeId: { userId: s.userId, episodeId: to.id } },
      });
      if (existing) {
        const watchedAt = [existing.watchedAt, s.watchedAt]
          .filter((value): value is Date => !!value)
          .sort((a, b) => a.getTime() - b.getTime())[0];
        await tx.userEpisodeStatus.update({
          where: { id: existing.id },
          data: {
            watched: existing.watched || s.watched,
            watchedAt: watchedAt ?? null,
            watchCount: Math.max(existing.watchCount, s.watchCount),
            device: existing.device ?? s.device,
          },
        });
        await tx.userEpisodeStatus.delete({ where: { id: s.id } });
      } else {
        await tx.userEpisodeStatus.update({ where: { id: s.id }, data: { episodeId: to.id } });
      }
      statuses++;
    }

    const histories = await tx.watchHistory.updateMany({
      where: { episodeId: from.id },
      data: { episodeId: to.id, seasonNumber: to.seasonNumber, episodeNumber: to.number },
    });
    // Collapse exact duplicates created when the user watched BOTH the stale and the
    // fresh row of the same episode (rewatch history is otherwise preserved row-for-row).
    await tx.$executeRaw`
          DELETE FROM watch_history a
          USING watch_history b
          WHERE a.episode_id = ${to.id} AND b.episode_id = ${to.id}
            AND a.user_id = b.user_id
            AND a.watched_at = b.watched_at
            AND a.id > b.id`;
    for (const h of await tx.watchHistory.findMany({
      where: { episodeId: to.id },
      select: { userId: true },
    })) {
      affectedUsers.add(h.userId);
    }

    let ratings = 0;
    for (const r of await tx.rating.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(r.userId);
      const existing = await tx.rating.findFirst({
        where: { userId: r.userId, episodeId: to.id },
      });
      if (existing) {
        if (preferSourceChoice(r, existing)) {
          await tx.rating.update({
            where: { id: existing.id },
            data: { rating: r.rating, source: r.source, sourceKey: r.sourceKey },
          });
        }
        await tx.rating.delete({ where: { id: r.id } });
      } else await tx.rating.update({ where: { id: r.id }, data: { episodeId: to.id } });
      ratings++;
    }

    let reactions = 0;
    for (const r of await tx.reaction.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(r.userId);
      const existing = await tx.reaction.findFirst({
        where: { userId: r.userId, episodeId: to.id, reaction: r.reaction },
      });
      if (existing) {
        if (preferSourceChoice(r, existing)) {
          await tx.reaction.update({
            where: { id: existing.id },
            data: { source: r.source, sourceKey: r.sourceKey, updatedAt: r.updatedAt },
          });
        }
        await tx.reaction.delete({ where: { id: r.id } });
      } else await tx.reaction.update({ where: { id: r.id }, data: { episodeId: to.id } });
      reactions++;
    }

    let votes = 0;
    for (const v of await tx.characterVote.findMany({ where: { episodeId: from.id } })) {
      affectedUsers.add(v.userId);
      const existing = await tx.characterVote.findFirst({
        where: { userId: v.userId, episodeId: to.id },
      });
      if (existing) {
        if (preferSourceChoice(v, existing)) {
          await tx.characterVote.update({
            where: { id: existing.id },
            data: { castId: v.castId, source: v.source, sourceKey: v.sourceKey },
          });
        }
        await tx.characterVote.delete({ where: { id: v.id } });
      } else await tx.characterVote.update({ where: { id: v.id }, data: { episodeId: to.id } });
      votes++;
    }

    const comments = await tx.comment.updateMany({
      where: { threadType: 'EPISODE', threadId: from.id },
      data: { threadId: to.id },
    });
    const externalReviews =
      typeof (tx as any).externalReview?.updateMany === 'function'
        ? await tx.externalReview.updateMany({
            where: { episodeId: from.id },
            data: { episodeId: to.id },
          })
        : { count: 0 };

    // Move provider cross-links the target lacks onto it, with their REAL values
    // (delete from the stale row first so the (provider, kind, value) unique index
    // can't collide inside the same transaction). Best-effort per id: a value
    // already claimed by a third row is logged, not fatal.
    const idMoves: { provider: ExternalProvider; value: string }[] = [];
    if (from.tmdbValue && !to.hasTmdb) {
      idMoves.push({ provider: ExternalProvider.TMDB, value: from.tmdbValue });
    }
    if (from.tvdbValue && from.tvdbValue !== to.tvdbValue) {
      idMoves.push({ provider: ExternalProvider.THE_TVDB, value: from.tvdbValue });
    }
    for (const m of idMoves) {
      try {
        await tx.episodeExternalId.deleteMany({
          where: { episodeId: from.id, provider: m.provider },
        });
        await tx.episodeExternalId.create({
          data: {
            episodeId: to.id,
            provider: m.provider,
            providerEntityKind: ProviderEntityKind.EPISODE,
            value: m.value,
          },
        });
      } catch (e) {
        this.logger.warn(
          `remap: could not move ${m.provider} episode id ${m.value} from ${from.id} to ${to.id}: ${(e as Error).message}`,
        );
      }
    }

    await tx.episode.delete({ where: { id: from.id } });
    return {
      statuses,
      histories: histories.count,
      ratings,
      reactions,
      votes,
      comments: comments.count,
      externalReviews: externalReviews.count,
    };
  }

  /** Classify episode ids by whether meaningful user data is attached — one set-based query
   *  (EXISTS per data table) instead of 5 count queries per episode. */
  private async splitByUserData(episodeIds: string[]): Promise<{ withData: Set<string> }> {
    if (episodeIds.length === 0) return { withData: new Set() };
    const rows = await this.prisma.$queryRaw<{ id: string; has_data: boolean }[]>(
      Prisma.sql`
        SELECT e.id, (
          EXISTS (
            SELECT 1 FROM user_episode_status u
            WHERE u.episode_id = e.id
              AND (u.watched = true OR u.watched_at IS NOT NULL OR u.watch_count > 0 OR u.device IS NOT NULL)
          )
          OR EXISTS (SELECT 1 FROM watch_history h WHERE h.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM ratings r WHERE r.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM reactions r WHERE r.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM character_votes v WHERE v.episode_id = e.id)
          OR EXISTS (SELECT 1 FROM comments c WHERE c.thread_type = 'EPISODE' AND c.thread_id = e.id)
          OR EXISTS (SELECT 1 FROM external_reviews er WHERE er.episode_id = e.id)
        ) AS has_data
        FROM episodes e
        WHERE e.id IN (${Prisma.join(episodeIds)})`,
    );
    return { withData: new Set(rows.filter((r) => r.has_data).map((r) => r.id)) };
  }

  /** Recompute one user's progress cache for the show (specials excluded), mirroring
   *  the import pipeline's rebuildShowStatuses. */
  private async recomputeUserShowStatus(userId: string, mediaId: string): Promise<void> {
    const [watched] = await this.prisma.$queryRaw<
      { watchedCount: number; lastWatchedAt: Date | null }[]
    >(
      Prisma.sql`
        SELECT COUNT(ues.id)::int AS "watchedCount", MAX(ues.watched_at) AS "lastWatchedAt"
        FROM user_episode_status ues
        JOIN episodes e ON ues.episode_id = e.id
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE ues.user_id = ${userId} AND ues.watched = true
          AND e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND s.is_special = false AND sh.media_id = ${mediaId}
          AND (e.air_date IS NULL OR e.air_date <= NOW())
        GROUP BY sh.media_id`,
    );
    const [totals] = await this.prisma.$queryRaw<{ totalCount: number }[]>(
      Prisma.sql`
        SELECT COUNT(e.id)::int AS "totalCount"
        FROM episodes e
        JOIN seasons s ON e.season_id = s.id
        JOIN shows sh ON s.show_id = sh.id
        WHERE e.structure_state = 'ACTIVE'::"EpisodeStructureState"
          AND s.is_special = false AND sh.media_id = ${mediaId}
          AND (e.air_date IS NULL OR e.air_date <= NOW())
        GROUP BY sh.media_id`,
    );
    await this.prisma.userShowStatus.upsert({
      where: { userId_mediaId: { userId, mediaId } },
      create: {
        userId,
        mediaId,
        watchedCount: watched?.watchedCount ?? 0,
        totalCount: totals?.totalCount ?? 0,
        lastWatchedAt: watched?.lastWatchedAt ?? null,
      },
      update: {
        watchedCount: watched?.watchedCount ?? 0,
        totalCount: totals?.totalCount ?? 0,
        lastWatchedAt: watched?.lastWatchedAt ?? null,
      },
    });
  }
}

function uniqueCandidate(
  candidates: EpRow[],
  predicate: (candidate: EpRow) => boolean,
): EpRow | null {
  const matches = candidates.filter(predicate);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Supporting signal only: this function is never called outside an already verified
 * canonical-show + exact-air-date candidate group. It tolerates leading articles,
 * punctuation, accents, and provider part suffixes. A translated title simply scores
 * zero and lets structural aired order decide instead.
 */
function supportingTitleSimilarity(left: string, right: string): number {
  const tokensOf = (value: string): string[] => {
    const normalized = value
      .toLocaleLowerCase()
      .normalize('NFKD')
      .replace(/\p{M}+/gu, '')
      .replace(/(?:\(|\[)?(?:part|pt)\.?\s*\d+(?:\)|\])?\s*$/giu, '')
      .replace(/(?:\(|\[)\d+(?:\)|\])\s*$/gu, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
    const tokens = normalized ? normalized.split(/\s+/u) : [];
    const articles = new Set([
      'a',
      'an',
      'the',
      'el',
      'la',
      'las',
      'los',
      'le',
      'les',
      'un',
      'une',
      'der',
      'die',
      'das',
      'il',
      'lo',
      'gli',
    ]);
    return tokens.length > 1 && articles.has(tokens[0]) ? tokens.slice(1) : tokens;
  };

  const leftTokens = tokensOf(left);
  const rightTokens = tokensOf(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;
  if (leftTokens.join(' ') === rightTokens.join(' ')) return 1;
  if (Math.min(leftTokens.length, rightTokens.length) === 1) return 0;

  const a = new Set(leftTokens);
  const b = new Set(rightTokens);
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / new Set([...a, ...b]).size;
}

/** Manual choices outrank imported choices. Within the same source tier, the newest
 * choice wins deterministically. */
function preferSourceChoice(
  source: { source?: unknown; updatedAt?: Date | null; createdAt: Date },
  target: { source?: unknown; updatedAt?: Date | null; createdAt: Date },
): boolean {
  const sourceManual = source.source === 'MANUAL';
  const targetManual = target.source === 'MANUAL';
  if (sourceManual !== targetManual) return sourceManual;
  const sourceAt = source.updatedAt ?? source.createdAt;
  const targetAt = target.updatedAt ?? target.createdAt;
  return sourceAt > targetAt;
}
