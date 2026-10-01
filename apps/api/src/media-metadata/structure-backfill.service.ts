import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { MediaMetadataService } from './media-metadata.service';
import { ProviderThrottled } from './providers/shared/provider-http';
import { STRUCTURE_RULE_VERSION } from './structure-authority.service';

/**
 * Structure authority backfill (milestone M4).
 *
 * Runs the existing authority evaluation (`evaluateShowStructureAuthority`, including its
 * protected remap) over shows whose episode-graph owner is unknown or suspect:
 *   1. no structure decision at all;
 *   2. anime not on ANIME_TVDB;
 *   3. LEGACY_UNMAPPED episodes that still carry user watch status;
 *   4. an outdated rule version, for shows with users only.
 * Users first. `dry-run` evaluates without writing; `apply` persists decisions/remaps.
 * TVDB-only shows have nothing to compare: `apply` queues the identity refresh that hydrates
 * them from TVDB and records TVDB_ONLY_FALLBACK.
 */
export type StructureBackfillOutcome =
  | 'unchanged'
  | 'decided'
  | 'migrated'
  | 'blocked'
  | 'deferred'
  | 'tvdb-only-refresh'
  | 'not-evaluated'
  | 'failed';

export interface StructureBackfillReport {
  mode: 'dry-run' | 'apply';
  processed: number;
  nextCursor: string | null;
  stoppedEarly: boolean;
  counts: Record<StructureBackfillOutcome, number>;
  samples: Array<{
    mediaId: string;
    title: string;
    outcome: StructureBackfillOutcome;
    detail?: string;
  }>;
}

/** Days before a show that is still a candidate after an evaluation is evaluated again. */
const RECHECK_DAYS = 30;

interface Target {
  id: string;
  title: string;
  priority: number;
  has_tmdb: boolean;
  has_tvdb: boolean;
}

@Injectable()
export class StructureBackfillService {
  private readonly logger = new Logger(StructureBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MediaMetadataService,
    @Optional() private readonly hydration?: HydrationQueue,
  ) {}

  async run(options: {
    mode: 'dry-run' | 'apply';
    limit?: number;
    cursor?: string | null;
    mediaId?: string;
    /** Epoch ms; the batch stops before starting a show after this time (resumes from the cursor). */
    deadline?: number;
    /** Called after each show, e.g. to feed the admin progress panel. */
    onProgress?: (processed: number, total: number, current: string) => void;
  }): Promise<StructureBackfillReport> {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 100), 1000));
    const report: StructureBackfillReport = {
      mode: options.mode,
      processed: 0,
      nextCursor: null,
      stoppedEarly: false,
      counts: {
        unchanged: 0,
        decided: 0,
        migrated: 0,
        blocked: 0,
        deferred: 0,
        'tvdb-only-refresh': 0,
        'not-evaluated': 0,
        failed: 0,
      },
      samples: [],
    };
    const targets = await this.targets(limit, options.cursor ?? null, options.mediaId);
    for (const target of targets) {
      if (options.deadline && Date.now() >= options.deadline) {
        report.stoppedEarly = true;
        break;
      }
      let outcome: StructureBackfillOutcome;
      let detail: string | undefined;
      try {
        if (!target.has_tmdb) {
          // Nothing to compare: hydrate from TVDB, which records the TVDB-only fallback.
          if (!target.has_tvdb) outcome = 'not-evaluated';
          else {
            if (options.mode === 'apply')
              await this.hydration?.enqueueIdentityRefresh(target.id, 'structure-backfill');
            outcome = 'tvdb-only-refresh';
          }
        } else {
          const result = await this.meta.evaluateShowStructureAuthority(target.id, {
            dryRun: options.mode !== 'apply',
          });
          detail = result.decision
            ? `${result.decision.provider}/${result.decision.reason}`
            : undefined;
          outcome = !result.evaluated
            ? 'not-evaluated'
            : result.deferred
              ? 'deferred'
              : result.blocked
                ? 'blocked'
                : result.report || result.preview
                  ? 'migrated'
                  : result.changed
                    ? 'decided'
                    : 'unchanged';
        }
      } catch (error) {
        if (error instanceof ProviderThrottled) {
          report.stoppedEarly = true;
          break;
        }
        outcome = 'failed';
        detail = (error as Error).message.slice(0, 160);
      }
      report.processed++;
      report.counts[outcome]++;
      report.nextCursor = `${target.priority}:${target.id}`;
      options.onProgress?.(report.processed, targets.length, target.title);
      if (report.samples.length < 50 && outcome !== 'unchanged')
        report.samples.push({ mediaId: target.id, title: target.title, outcome, detail });
      if (options.mode === 'apply') await this.markChecked(target.id, outcome);
    }
    if (!report.stoppedEarly && targets.length < limit) report.nextCursor = null;
    this.logger.log(
      `structure-backfill (${options.mode}): processed=${report.processed} ${JSON.stringify(report.counts)}`,
    );
    return report;
  }

  /**
   * Shows that stay candidates after an evaluation (blocked, no decision, a queued TVDB-only
   * refresh) are not re-evaluated on every pass: the stamp spaces out their rechecks.
   */
  private async markChecked(mediaId: string, outcome: StructureBackfillOutcome) {
    const marker = JSON.stringify({ checkedAt: new Date().toISOString(), outcome });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE media_items
      SET metadata_provenance = jsonb_set(coalesce(metadata_provenance, '{}'::jsonb),
        '{structureBackfill}', ${marker}::jsonb, true)
      WHERE id = ${mediaId}`);
  }

  /** Candidate shows ranked by urgency (users/unknown owner first), keyset-paginated. */
  private async targets(limit: number, cursor: string | null, mediaId?: string) {
    const [rank, id] = cursor?.includes(':') ? cursor.split(/:(.*)/s) : ['0', ''];
    return this.prisma.$queryRaw<Target[]>(Prisma.sql`
      WITH shows_scored AS (
        SELECT m.id, m.title,
          EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = m.id) AS has_users,
          s.structure_provider IS NULL AS undecided,
          (m.content_classification = 'ANIME' AND s.structure_reason IS DISTINCT FROM 'ANIME_TVDB') AS anime_misrouted,
          EXISTS (SELECT 1 FROM seasons se JOIN episodes e ON e.season_id = se.id
            JOIN user_episode_status ues ON ues.episode_id = e.id
            WHERE se.show_id = s.id AND e.structure_state = 'LEGACY_UNMAPPED') AS legacy_users,
          coalesce(s.structure_rule_version, 0) < ${STRUCTURE_RULE_VERSION}::int AS outdated,
          EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider = 'TMDB'
            AND x.provider_entity_kind = 'SERIES') AS has_tmdb,
          EXISTS (SELECT 1 FROM external_ids x WHERE x.media_id = m.id AND x.provider = 'THE_TVDB'
            AND x.provider_entity_kind = 'SERIES') AS has_tvdb
        FROM media_items m JOIN shows s ON s.media_id = m.id
        WHERE m.type = 'SHOW'
          AND (${mediaId ?? null}::text IS NULL OR m.id = ${mediaId ?? null})
          AND NOT EXISTS (SELECT 1 FROM media_canonical_links l
            WHERE l.source_media_id = m.id AND l.status = 'ACTIVE')
          AND s.structure_reason IS DISTINCT FROM 'MANUAL_OVERRIDE'
          AND (${mediaId ?? null}::text IS NOT NULL OR coalesce(
            (m.metadata_provenance -> 'structureBackfill' ->> 'checkedAt')::timestamptz, 'epoch')
            < now() - make_interval(days => CASE m.metadata_provenance -> 'structureBackfill' ->> 'outcome'
              WHEN 'failed' THEN 1 WHEN 'deferred' THEN 1 WHEN 'tvdb-only-refresh' THEN 7
              ELSE ${RECHECK_DAYS}::int END))
      ), ranked AS (
        SELECT id, title, has_tmdb, has_tvdb,
          CASE
            WHEN has_users AND (undecided OR legacy_users) THEN 0
            WHEN has_users AND anime_misrouted THEN 1
            WHEN has_users AND outdated THEN 2
            WHEN undecided THEN 3
            WHEN anime_misrouted THEN 4
            ELSE NULL
          END AS priority
        FROM shows_scored
      )
      SELECT id, title, priority, has_tmdb, has_tvdb FROM ranked
      WHERE priority IS NOT NULL
        AND (priority, id) > (${Number(rank) || 0}::int, ${id ?? ''})
      ORDER BY priority, id
      LIMIT ${limit}`);
  }
}
