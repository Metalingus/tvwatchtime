import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbProvider } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { isProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';
import { IdentityRef, MediaReconciler } from './reconcile/media-reconciler.service';
import { isStrictTmdbAnime } from './structure-authority.service';
import { canonicalMediaId } from './util/canonical-media';

/**
 * One-time identity backlog (milestone M3).
 *
 * For live rows missing a TMDB or TVDB id, establish the cross-provider id from **independent**
 * provider statements, then either attach it (nobody owns it) or consolidate the duplicate row
 * that owns it through the existing copy-only canonicalization.
 *
 * Evidence tiers:
 *   A  TMDB and TVDB each name the other (two independent statements).
 *   B  One provider names the other and both providers report the same IMDb id
 *      (for movies: an exact IMDb → TMDB translation whose profile returns that IMDb id).
 *   C  WatchForge (backlog lane, opt-in) plus live provider corroboration.
 * Title/year similarity is never evidence: those pairs are reported, never applied.
 *
 * Dry-run performs provider reads only. Apply writes aliases/merges and marks each row so a
 * definitive "nothing to do" is not re-checked for 30 days.
 */
export type BacklogTier = 'A' | 'B' | 'C';
export type BacklogAction =
  | 'attach'
  | 'consolidate'
  | 'already-linked'
  | 'no-crosswalk'
  | 'unproven'
  | 'conflict'
  | 'dead-alias'
  | 'ambiguous-owner'
  | 'blocked'
  | 'deferred'
  | 'skipped';

export interface CrosswalkEvidence {
  /** Ids proven for this work (always includes the row's anchor). */
  ids: IdentityRef[];
  tier: BacklogTier | null;
  reason: string;
}

interface Statement {
  tmdbId: number | null;
  tvdbId: number | null;
  imdbId: string | null;
}

/**
 * Grades a TMDB ↔ TVDB crosswalk for one work from each provider's own statement.
 * `tmdb` is TMDB's profile of the TMDB id, `tvdb` is TVDB's record of the TVDB id.
 */
export function gradeShowCrosswalk(tmdb: Statement, tvdb: Statement): BacklogTier | null {
  if (!tmdb.tmdbId || !tvdb.tvdbId) return null;
  const tmdbNamesTvdb = tmdb.tvdbId === tvdb.tvdbId;
  const tvdbNamesTmdb = tvdb.tmdbId === tmdb.tmdbId;
  // An explicit contradiction by either provider is never overruled by the other.
  if ((tmdb.tvdbId && !tmdbNamesTvdb) || (tvdb.tmdbId && !tvdbNamesTmdb)) return null;
  if (tmdbNamesTvdb && tvdbNamesTmdb) return 'A';
  const imdbAgrees =
    !!tmdb.imdbId && !!tvdb.imdbId && tmdb.imdbId.toLowerCase() === tvdb.imdbId.toLowerCase();
  if ((tmdbNamesTvdb || tvdbNamesTmdb) && imdbAgrees) return 'B';
  return null;
}

/** A provider contradicts itself about one id (e.g. several TVDB remote ids for one record). */
export class CrosswalkConflict extends Error {}

const DEFAULT_LIMIT = 200;
const RECHECK_AFTER_DAYS = 30;
const MAX_SAMPLES = 50;

interface TargetRow {
  id: string;
  type: 'SHOW' | 'MOVIE';
  title: string;
  classification: string;
  has_users: boolean;
  ids: string[] | null;
}

export interface BacklogReport {
  mode: 'dry-run' | 'apply';
  processed: number;
  nextCursor: string | null;
  stoppedEarly: boolean;
  counts: Record<BacklogAction, number>;
  tiers: Record<BacklogTier, number>;
  samples: Array<{
    mediaId: string;
    title: string;
    action: BacklogAction;
    tier?: BacklogTier | null;
    reason?: string;
    otherMediaId?: string;
  }>;
}

@Injectable()
export class IdentityBacklogService {
  private readonly logger = new Logger(IdentityBacklogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
    private readonly reconciler: MediaReconciler,
    @Optional() private readonly canonical?: MediaCanonicalizationService,
    @Optional() private readonly hydration?: HydrationQueue,
  ) {}

  async run(options: {
    mode: 'dry-run' | 'apply';
    limit?: number;
    cursor?: string | null;
    mediaId?: string;
    watchforge?: boolean;
    /** Epoch ms; the batch stops before starting a row after this time (resumes from the cursor). */
    deadline?: number;
    /** Called after each row, e.g. to feed the admin progress panel. */
    onProgress?: (processed: number, total: number, current: string) => void;
  }): Promise<BacklogReport> {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_LIMIT), 1000));
    const report: BacklogReport = {
      mode: options.mode,
      processed: 0,
      nextCursor: null,
      stoppedEarly: false,
      counts: Object.fromEntries(
        (
          [
            'attach',
            'consolidate',
            'already-linked',
            'no-crosswalk',
            'unproven',
            'conflict',
            'dead-alias',
            'ambiguous-owner',
            'blocked',
            'deferred',
            'skipped',
          ] as BacklogAction[]
        ).map((a) => [a, 0]),
      ) as Record<BacklogAction, number>,
      tiers: { A: 0, B: 0, C: 0 },
      samples: [],
    };
    const rows = await this.targets(limit, options.cursor ?? null, options.mediaId);
    for (const row of rows) {
      if (options.deadline && Date.now() >= options.deadline) {
        report.stoppedEarly = true;
        break;
      }
      let outcome: {
        action: BacklogAction;
        retry?: boolean;
        tier?: BacklogTier | null;
        reason?: string;
        otherMediaId?: string;
      };
      try {
        outcome = await this.process(row, options.mode, options.watchforge === true);
      } catch (error) {
        if (error instanceof ProviderThrottled) {
          // Provider budget exhausted: resume from this row next run.
          report.stoppedEarly = true;
          report.counts.deferred++;
          break;
        }
        outcome =
          error instanceof CrosswalkConflict
            ? { action: 'conflict', reason: 'conflict:tvdb-self-contradiction' }
            : { action: 'deferred', reason: (error as Error).message.slice(0, 200) };
      }
      report.processed++;
      report.counts[outcome.action]++;
      if (outcome.tier) report.tiers[outcome.tier]++;
      report.nextCursor = this.cursorOf(row);
      options.onProgress?.(report.processed, rows.length, row.title);
      if (report.samples.length < MAX_SAMPLES && outcome.action !== 'no-crosswalk')
        report.samples.push({ mediaId: row.id, title: row.title, ...outcome });
      // Stale targets and transient failures stay eligible for the next pass.
      if (options.mode === 'apply' && outcome.action !== 'deferred' && !outcome.retry)
        await this.markChecked(row.id, outcome.action, outcome.tier ?? null);
    }
    // A short final page means the pass is complete; the next run starts over.
    if (!report.stoppedEarly && rows.length < limit) report.nextCursor = null;
    return report;
  }

  private cursorOf(row: TargetRow) {
    return `${row.has_users ? 0 : 1}:${row.id}`;
  }

  /** Live rows missing a provider id, users first, keyset-paginated; recently settled rows skip. */
  private async targets(limit: number, cursor: string | null, mediaId?: string) {
    const [rank, id] = cursor?.includes(':') ? cursor.split(/:(.*)/s) : ['0', ''];
    return this.prisma.$queryRaw<TargetRow[]>(Prisma.sql`
      WITH candidates AS (
        SELECT m.id, m.type::text AS type, m.title, m.content_classification::text AS classification,
          CASE WHEN m.type = 'SHOW'
            THEN EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = m.id)
            ELSE EXISTS (SELECT 1 FROM user_movie_status u WHERE u.media_id = m.id)
              OR EXISTS (SELECT 1 FROM watch_history w WHERE w.media_id = m.id)
          END AS has_users,
          (SELECT array_agg(e.provider::text || ':' || e.value ORDER BY e.id) FROM external_ids e
            WHERE e.media_id = m.id AND e.provider IN ('TMDB', 'THE_TVDB', 'IMDB')
              AND e.provider_entity_kind::text = CASE WHEN m.type = 'SHOW' THEN 'SERIES' ELSE 'MOVIE' END
          ) AS ids
        FROM media_items m
        WHERE (${mediaId ?? null}::text IS NULL OR m.id = ${mediaId ?? null})
          AND NOT EXISTS (SELECT 1 FROM media_canonical_links l
            WHERE l.source_media_id = m.id AND l.status = 'ACTIVE')
          AND NOT (m.type = 'MOVIE' AND EXISTS (SELECT 1 FROM shows s WHERE s.media_id = m.id))
          AND NOT (m.type = 'SHOW' AND EXISTS (SELECT 1 FROM movies v WHERE v.media_id = m.id))
          AND (${mediaId ?? null}::text IS NOT NULL OR coalesce(
            (m.metadata_provenance -> 'identityBacklog' ->> 'checkedAt')::timestamptz,
            'epoch') < now() - make_interval(days => ${RECHECK_AFTER_DAYS}::int))
      )
      SELECT * FROM candidates c
      WHERE (
          (c.type = 'SHOW' AND (
            NOT EXISTS (SELECT 1 FROM unnest(c.ids) v WHERE v LIKE 'TMDB:%')
            OR NOT EXISTS (SELECT 1 FROM unnest(c.ids) v WHERE v LIKE 'THE_TVDB:%')))
          OR (c.type = 'MOVIE' AND NOT EXISTS (SELECT 1 FROM unnest(c.ids) v WHERE v LIKE 'TMDB:%'))
        )
        AND c.ids IS NOT NULL
        AND (CASE WHEN c.has_users THEN 0 ELSE 1 END, c.id) > (${Number(rank) || 0}, ${id ?? ''})
      ORDER BY CASE WHEN c.has_users THEN 0 ELSE 1 END, c.id
      LIMIT ${limit}`);
  }

  private async markChecked(mediaId: string, outcome: BacklogAction, tier: BacklogTier | null) {
    const marker = JSON.stringify({ checkedAt: new Date().toISOString(), outcome, tier });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE media_items
      SET metadata_provenance = coalesce(metadata_provenance, '{}'::jsonb)
        || jsonb_build_object('identityBacklog', ${marker}::jsonb)
      WHERE id = ${mediaId}`);
  }

  private async process(row: TargetRow, mode: 'dry-run' | 'apply', watchforge: boolean) {
    const ids = (row.ids ?? []).map((value) => {
      const [provider, ...rest] = value.split(':');
      return { provider, value: rest.join(':') };
    });
    const values = (provider: string) => ids.filter((id) => id.provider === provider);
    // Multi-alias rows are a different defect (identity repair); never guess which alias counts.
    if (values('TMDB').length > 1 || values('THE_TVDB').length > 1 || values('IMDB').length > 1)
      return { action: 'skipped' as const, reason: 'multi-alias-row' };
    const kind = row.type === 'SHOW' ? ProviderEntityKind.SERIES : ProviderEntityKind.MOVIE;
    const evidence =
      row.type === 'SHOW'
        ? await this.showCrosswalk(values('TMDB')[0]?.value, values('THE_TVDB')[0]?.value)
        : await this.movieCrosswalk(values('IMDB')[0]?.value, values('THE_TVDB')[0]?.value);
    if (evidence.reason === 'tvdb-dead' || evidence.reason === 'tmdb-dead')
      return { action: 'dead-alias' as const, reason: evidence.reason };
    let proven = evidence;
    if (!proven.tier && watchforge && row.has_users)
      proven = await this.watchforgeCrosswalk(row, ids);
    if (!proven.tier)
      return {
        action: (proven.reason.startsWith('conflict')
          ? 'conflict'
          : proven.reason === 'no-crosswalk'
            ? 'no-crosswalk'
            : 'unproven') as BacklogAction,
        reason: proven.reason,
      };
    const tier = proven.tier;
    const missing = proven.ids.filter(
      (id) => !ids.some((own) => own.provider === id.provider && own.value === id.value),
    );
    if (!missing.length) return { action: 'already-linked' as const, tier };
    // Who already owns the ids this row lacks?
    const owners = new Set<string>();
    for (const id of missing) {
      const owner = await this.prisma.externalId.findFirst({
        where: { provider: id.provider, providerEntityKind: kind, value: id.value },
        select: { mediaId: true },
      });
      if (owner) owners.add(await canonicalMediaId(this.prisma, owner.mediaId));
    }
    owners.delete(row.id);
    if (owners.size > 1)
      return { action: 'ambiguous-owner' as const, tier, reason: [...owners].join(',') };
    if (owners.size === 0) {
      if (mode === 'apply')
        for (const id of missing) await this.reconciler.attachExternalId(row.id, id);
      return {
        action: 'attach' as const,
        tier,
        reason: missing.map((i) => i.provider + ':' + i.value).join(','),
      };
    }
    const [other] = owners;
    const merged = await this.consolidate(row, other, proven, mode);
    return { ...merged, tier, otherMediaId: other };
  }

  /** TMDB and TVDB statements about one show; each provider is asked about its own id. */
  async showCrosswalk(tmdbValue?: string, tvdbValue?: string): Promise<CrosswalkEvidence> {
    const kind = ProviderEntityKind.SERIES;
    let tmdbId = tmdbValue ? Number(tmdbValue) : null;
    let tvdbId = tvdbValue ? Number(tvdbValue) : null;
    let tvdbStatement: Statement | null = null;
    if (tvdbId) {
      tvdbStatement = await this.tvdbStatement(tvdbId, 'tv');
      if (!tvdbStatement) return { ids: [], tier: null, reason: 'tvdb-dead' };
      if (!tmdbId) {
        const found = await this.tmdb.findByExternalIdStrict(tvdbId, 'tvdb_id');
        tmdbId = found?.show?.tmdbId ?? tvdbStatement.tmdbId;
      }
    }
    if (!tmdbId) return { ids: [], tier: null, reason: 'no-crosswalk' };
    const profile = await this.tmdbShowProfile(tmdbId);
    if (!profile) return { ids: [], tier: null, reason: tmdbValue ? 'tmdb-dead' : 'no-crosswalk' };
    if (!tvdbId) {
      tvdbId = profile.tvdbId;
      if (!tvdbId) return { ids: [], tier: null, reason: 'no-crosswalk' };
      tvdbStatement = await this.tvdbStatement(tvdbId, 'tv');
      if (!tvdbStatement) return { ids: [], tier: null, reason: 'unproven:tmdb-names-dead-tvdb' };
    }
    const tier = gradeShowCrosswalk(
      { tmdbId, tvdbId: profile.tvdbId, imdbId: profile.imdbId },
      tvdbStatement!,
    );
    if (!tier) {
      const contradiction =
        (profile.tvdbId && profile.tvdbId !== tvdbId) ||
        (tvdbStatement!.tmdbId && tvdbStatement!.tmdbId !== tmdbId);
      return {
        ids: [],
        tier: null,
        reason: contradiction ? 'conflict:providers-disagree' : 'unproven:one-sided',
      };
    }
    const imdb = profile.imdbId ?? tvdbStatement!.imdbId;
    return {
      tier,
      reason: 'verified',
      ids: [
        { provider: ExternalProvider.TMDB, providerEntityKind: kind, value: String(tmdbId) },
        { provider: ExternalProvider.THE_TVDB, providerEntityKind: kind, value: String(tvdbId) },
        ...(imdb
          ? [{ provider: ExternalProvider.IMDB, providerEntityKind: kind, value: imdb }]
          : []),
      ],
    };
  }

  /** Movies: an exact IMDb translation, corroborated by TMDB's profile and, when present, TVDB. */
  async movieCrosswalk(imdbValue?: string, tvdbValue?: string): Promise<CrosswalkEvidence> {
    const kind = ProviderEntityKind.MOVIE;
    let imdb = imdbValue ?? null;
    let tvdb: Statement | null = null;
    if (tvdbValue) {
      tvdb = await this.tvdbStatement(Number(tvdbValue), 'movie');
      if (!tvdb) return { ids: [], tier: null, reason: 'tvdb-dead' };
      if (imdb && tvdb.imdbId && tvdb.imdbId !== imdb)
        return { ids: [], tier: null, reason: 'conflict:imdb-disagrees' };
      imdb ??= tvdb.imdbId;
    }
    if (!imdb) return { ids: [], tier: null, reason: 'no-crosswalk' };
    const found = await this.tmdb.findByExternalIdStrict(imdb, 'imdb_id');
    const tmdbId = found?.movie?.tmdbId ?? null;
    if (!tmdbId)
      return {
        ids: [],
        tier: null,
        reason: found?.show ? 'conflict:imdb-is-a-show' : 'no-crosswalk',
      };
    const profile = await this.tmdb.getMovieRoutingProfile(tmdbId).catch((e) => {
      if (isProviderError(e) && e.notFound) return null;
      throw e;
    });
    if (!profile?.imdbId || profile.imdbId !== imdb)
      return { ids: [], tier: null, reason: 'unproven:tmdb-profile-imdb' };
    if (tvdb?.tmdbId && tvdb.tmdbId !== tmdbId)
      return { ids: [], tier: null, reason: 'conflict:tvdb-names-other-tmdb' };
    return {
      tier: tvdb?.tmdbId === tmdbId ? 'A' : 'B',
      reason: 'verified',
      ids: [
        { provider: ExternalProvider.TMDB, providerEntityKind: kind, value: String(tmdbId) },
        { provider: ExternalProvider.IMDB, providerEntityKind: kind, value: imdb },
        ...(tvdbValue
          ? [{ provider: ExternalProvider.THE_TVDB, providerEntityKind: kind, value: tvdbValue }]
          : []),
      ],
    };
  }

  /** Tier C: WatchForge evidence (backlog lane) that the reconciler corroborates live. */
  private async watchforgeCrosswalk(
    row: TargetRow,
    ids: Array<{ provider: string; value: string }>,
  ): Promise<CrosswalkEvidence> {
    const anchor =
      ids.find((id) => id.provider === 'TMDB') ??
      ids.find((id) => id.provider === 'THE_TVDB') ??
      ids.find((id) => id.provider === 'IMDB');
    if (!anchor) return { ids: [], tier: null, reason: 'no-crosswalk' };
    const provider = ({ TMDB: 'tmdb', THE_TVDB: 'tvdb', IMDB: 'imdb' } as const)[
      anchor.provider as 'TMDB' | 'THE_TVDB' | 'IMDB'
    ];
    const result = await this.reconciler.resolveProviderIdentity(
      { provider, id: anchor.value, mediaType: row.type === 'SHOW' ? 'tv' : 'movie' },
      { lane: 'backlog', primaryOnly: row.type === 'MOVIE' && provider !== 'tvdb' },
    );
    if (result.status === 'verified' && result.anchorVerified && !result.retiredAnchor)
      return { ids: result.externals, tier: 'C', reason: 'verified' };
    return {
      ids: [],
      tier: null,
      reason:
        result.status === 'conflict'
          ? 'conflict:' + result.reason
          : 'unproven:watchforge-' + result.status,
    };
  }

  private async tvdbStatement(tvdbId: number, type: 'tv' | 'movie'): Promise<Statement | null> {
    try {
      const identity =
        type === 'tv'
          ? await this.tvdb.getShowIdentity(tvdbId)
          : await this.tvdb.getMovieIdentity(tvdbId);
      return { tmdbId: identity.tmdbId, tvdbId, imdbId: identity.imdbId };
    } catch (error) {
      if (isProviderError(error) && error.notFound) return null;
      // TVDB records that disagree with themselves are evidence problems, not outages.
      if (
        !isProviderError(error) &&
        /^(Conflicting TVDB|TVDB returned a different)/.test(String((error as Error)?.message))
      )
        throw new CrosswalkConflict((error as Error).message);
      throw error;
    }
  }

  private async tmdbShowProfile(tmdbId: number) {
    try {
      return await this.tmdb.getShowRoutingProfile(tmdbId);
    } catch (error) {
      if (isProviderError(error) && error.notFound) return null;
      throw error;
    }
  }

  /**
   * Consolidate a proven duplicate pair through the copy-only canonical ledger. The survivor
   * follows docs/METADATA_OPERATIONS.md: anime → the TVDB row; a TVDB row evaluated GENERAL_TVDB
   * → that row; otherwise the TMDB row. Every core alias on both rows must be proven.
   */
  private async consolidate(
    row: TargetRow,
    otherId: string,
    proven: CrosswalkEvidence,
    mode: 'dry-run' | 'apply',
  ): Promise<{ action: BacklogAction; reason?: string; retry?: boolean }> {
    if (!this.canonical) return { action: 'blocked', reason: 'canonicalization-unavailable' };
    const members = await this.prisma.mediaItem.findMany({
      where: { id: { in: [row.id, otherId] } },
      select: {
        id: true,
        type: true,
        contentClassification: true,
        externalIds: { select: { provider: true, value: true } },
        show: { select: { structureProvider: true, structureReason: true } },
        movie: { select: { releaseYear: true, runtimeMinutes: true } },
      },
    });
    if (members.length !== 2 || members.some((m) => m.type !== row.type))
      return { action: 'blocked', reason: 'type-mismatch' };
    const tmdb = proven.ids.find((id) => id.provider === 'TMDB')?.value;
    const tvdb = proven.ids.find((id) => id.provider === 'THE_TVDB')?.value;
    const owns = (m: (typeof members)[number], provider: string, value?: string) =>
      !!value && m.externalIds.some((id) => id.provider === provider && id.value === value);
    let targetId: string;
    let canonical: 'tmdb' | 'tvdb' | undefined;
    let snapshot: any;
    let foreignSnapshot: any;
    if (row.type === 'SHOW') {
      const tvdbRow = members.find((m) => owns(m, 'THE_TVDB', tvdb));
      const tmdbRow = members.find((m) => owns(m, 'TMDB', tmdb));
      if (!tvdbRow || !tmdbRow || tvdbRow.id === tmdbRow.id)
        return { action: 'blocked', reason: 'owners-not-split-by-provider' };
      const manual = members.filter((m) => m.show?.structureReason === 'MANUAL_OVERRIDE');
      if (manual.length > 1) return { action: 'blocked', reason: 'conflicting-manual-authority' };
      const profile = await this.tmdbShowProfile(Number(tmdb));
      const anime =
        members.some((m) => m.contentClassification === 'ANIME') ||
        (!!profile && isStrictTmdbAnime(profile.genreIds, profile.keywords));
      const target =
        manual[0] ??
        (anime || tvdbRow.show?.structureReason === 'GENERAL_TVDB' ? tvdbRow : tmdbRow);
      targetId = target.id;
      canonical =
        target.show?.structureReason === 'MANUAL_OVERRIDE'
          ? target.show.structureProvider === 'TVDB'
            ? 'tvdb'
            : 'tmdb'
          : target.show?.structureProvider === 'TVDB' || anime
            ? 'tvdb'
            : 'tmdb';
      const tvdbShow = () =>
        this.tvdb.getShow(Number(tvdb), 'en', { seasonType: 'official', bypassCache: true });
      const tmdbShow = () => this.tmdb.getShow(Number(tmdb), 'en-US', { bypassCache: true });
      [snapshot, foreignSnapshot] =
        canonical === 'tvdb'
          ? await Promise.all([tvdbShow(), tmdbShow()])
          : await Promise.all([tmdbShow(), tvdbShow()]);
    } else {
      const [a, b] = members;
      if (
        a.movie?.releaseYear &&
        b.movie?.releaseYear &&
        Math.abs(a.movie.releaseYear - b.movie.releaseYear) > 1
      )
        return { action: 'blocked', reason: 'movie-year-disagreement' };
      if (
        a.movie?.runtimeMinutes &&
        b.movie?.runtimeMinutes &&
        Math.abs(a.movie.runtimeMinutes - b.movie.runtimeMinutes) > 10
      )
        return { action: 'blocked', reason: 'movie-runtime-disagreement' };
      targetId = (members.find((m) => owns(m, 'TMDB', tmdb)) ?? a).id;
    }
    const family = {
      verifiedIds: proven.ids,
      canonical,
      snapshot: snapshot?.seasons,
      foreignSnapshot: foreignSnapshot?.seasons,
      evidence: { source: 'identity-backlog', tier: proven.tier },
    };
    const ids = [row.id, otherId];
    const preview = await this.canonical.identityFamily(ids, targetId, {
      ...family,
      mode: 'dry-run',
    });
    if (preview.reason === 'target-graph-is-stale') {
      // Refresh the survivor's graph from its canonical provider; the next pass retries.
      if (mode === 'apply')
        await this.hydration?.enqueueIdentityRefresh(
          targetId,
          'backlog-' + preview.fingerprint.slice(0, 16),
        );
      return { action: 'blocked', reason: preview.reason, retry: true };
    }
    if (preview.status !== 'ready')
      return { action: 'blocked', reason: preview.reason || preview.status };
    if (mode === 'dry-run') return { action: 'consolidate', reason: `target:${targetId}` };
    const applied = await this.canonical.identityFamily(ids, targetId, {
      ...family,
      mode: 'repair',
      fingerprint: preview.fingerprint,
    });
    if (applied.status !== 'applied')
      return { action: 'blocked', reason: applied.reason || applied.status };
    await this.prisma.adminAuditLog.create({
      data: {
        adminId: 'identity-backlog',
        action: 'identity_backlog_consolidate',
        targetType: 'media',
        targetId,
        metadata: {
          members: ids,
          tier: proven.tier,
          verifiedIds: proven.ids as any,
          activated: applied.activated,
        } as any,
      },
    });
    this.logger.log(
      `identity-backlog: consolidated ${ids.join(' + ')} → ${targetId} (tier ${proven.tier})`,
    );
    return { action: 'consolidate', reason: `target:${targetId}` };
  }
}
