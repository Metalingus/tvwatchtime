import { Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { IdentityRepairService, IdentityVerificationDeferred } from './identity-repair.service';

/**
 * Identity repair sweep: runs the verified identity repair (`repairAutomatically`, the same path
 * imports trigger) over rows whose ids are internally inconsistent:
 *   - type mismatch: a MOVIE row carrying a show graph, or a SHOW row carrying a movie row;
 *   - wrong kind: a SERIES id on a movie row, or a MOVIE id on a show row;
 *   - multi-alias: more than one TMDB/TVDB/IMDb id of the same kind.
 * The repair only acts on provider-verified plans (split, partition, attach, consolidate);
 * everything else is left untouched and reported as blocked. Users first. Each checked row is
 * stamped with its alias fingerprint so unchanged rows are not re-verified for RECHECK_DAYS.
 */
export type SweepOutcome = 'repaired' | 'verified' | 'blocked' | 'deferred' | 'failed';

export interface SweepReport {
  mode: 'dry-run' | 'apply';
  processed: number;
  nextCursor: string | null;
  stoppedEarly: boolean;
  stopReason?: string;
  counts: Record<SweepOutcome, number>;
  reasons: Record<string, number>;
  samples: Array<{ mediaId: string; title: string; outcome: SweepOutcome; reason?: string }>;
}

interface Target {
  id: string;
  title: string;
  rank: number;
  fingerprint: string;
}

const RECHECK_DAYS = 30;
/** Transient failures come back sooner than verified-but-blocked rows. */
const FAILED_RECHECK_DAYS = 3;
const MAX_SAMPLES = 30;

@Injectable()
export class IdentityRepairSweepService {
  private readonly logger = new Logger(IdentityRepairSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly identityRepair: IdentityRepairService,
    @Optional() private readonly hydration?: HydrationQueue,
  ) {}

  async run(options: {
    mode: 'dry-run' | 'apply';
    limit?: number;
    cursor?: string | null;
    mediaId?: string;
    /** Epoch ms; the sweep stops before starting a row after this time. */
    deadline?: number;
    onProgress?: (processed: number, total: number, current: string) => void;
  }): Promise<SweepReport> {
    const limit = Math.max(1, Math.min(Math.floor(options.limit ?? 25), 500));
    const report: SweepReport = {
      mode: options.mode,
      processed: 0,
      nextCursor: options.cursor ?? null,
      stoppedEarly: false,
      counts: { repaired: 0, verified: 0, blocked: 0, deferred: 0, failed: 0 },
      reasons: {},
      samples: [],
    };
    const targets = await this.targets(limit, options.cursor ?? null, options.mediaId);
    for (const target of targets) {
      if (options.deadline && Date.now() >= options.deadline) {
        report.stoppedEarly = true;
        report.stopReason = 'time-budget';
        break;
      }
      let outcome: SweepOutcome;
      let reason: string | undefined;
      try {
        ({ outcome, reason } =
          options.mode === 'apply' ? await this.apply(target.id) : await this.preview(target.id));
      } catch (error) {
        if (error instanceof IdentityVerificationDeferred) {
          // Quota or provider outage: resume from this row next run; never a data failure.
          report.stoppedEarly = true;
          report.stopReason = `deferred:${error.reason}`.slice(0, 120);
          report.counts.deferred++;
          break;
        }
        outcome = 'failed';
        reason = (error as Error).message.slice(0, 160);
      }
      if (outcome === 'deferred') {
        report.stoppedEarly = true;
        report.stopReason = `deferred:${reason ?? 'unavailable'}`.slice(0, 120);
        report.counts.deferred++;
        break;
      }
      report.processed++;
      report.counts[outcome]++;
      if (reason && outcome !== 'repaired' && outcome !== 'verified')
        report.reasons[reason.slice(0, 60)] = (report.reasons[reason.slice(0, 60)] ?? 0) + 1;
      report.nextCursor = `${target.rank}:${target.id}`;
      options.onProgress?.(report.processed, targets.length, target.title);
      if (report.samples.length < MAX_SAMPLES && outcome !== 'verified')
        report.samples.push({ mediaId: target.id, title: target.title, outcome, reason });
      if (options.mode === 'apply') await this.markChecked(target, outcome, reason);
    }
    // A short final page completes the pass; the next run starts over.
    if (!report.stoppedEarly && targets.length < limit) report.nextCursor = null;
    this.logger.log(
      `identity-sweep (${options.mode}): processed=${report.processed} ${JSON.stringify(report.counts)}`,
    );
    return report;
  }

  private async apply(mediaId: string): Promise<{ outcome: SweepOutcome; reason?: string }> {
    const result = await this.identityRepair.repairAutomatically(mediaId);
    if (!result.repaired && result.reason === 'disabled')
      return { outcome: 'deferred', reason: 'watchforge-disabled' };
    // Applied plans defer their metadata refresh to the caller (same as the hydration worker).
    for (const followUp of result.followUps) {
      await this.hydration
        ?.enqueueIdentityRefresh(followUp.mediaId, 'identity-sweep', followUp.operationId)
        .catch((error: Error) =>
          this.logger.warn(`identity-sweep follow-up for ${followUp.mediaId}: ${error.message}`),
        );
    }
    // A plan can apply (e.g. a split) and the next verification step then stop: report the
    // applied part as a repair, with the remaining blocker as its reason.
    if (!result.repaired)
      return result.followUps.length
        ? { outcome: 'repaired', reason: `partial: ${result.reason ?? 'needs verification'}` }
        : { outcome: 'blocked', reason: result.reason };
    return { outcome: result.followUps.length ? 'repaired' : 'verified' };
  }

  /** Dry-run: the verified plan the repair would apply, without applying it. */
  private async preview(mediaId: string): Promise<{ outcome: SweepOutcome; reason?: string }> {
    const plan = await this.identityRepair.preview({ mediaId }, 'identity-sweep-dry-run');
    if (plan.status === 'deferred')
      return { outcome: 'deferred', reason: String(plan.reason ?? 'unavailable') };
    if (plan.status !== 'ready') return { outcome: 'blocked', reason: String(plan.reason ?? '') };
    return plan.action === 'refresh'
      ? { outcome: 'verified' }
      : { outcome: 'repaired', reason: `would-${plan.action}` };
  }

  /** Rows with inconsistent ids, users first, keyset-paginated; unchanged rows skip rechecks. */
  private targets(limit: number, cursor: string | null, mediaId?: string) {
    const [rank, id] = cursor?.includes(':') ? cursor.split(/:(.*)/s) : ['0', ''];
    return this.prisma.$queryRaw<Target[]>(Prisma.sql`
      WITH candidates AS (
        SELECT m.id, m.title, m.metadata_provenance -> 'identitySweep' AS stamp,
          CASE WHEN EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = m.id)
            OR EXISTS (SELECT 1 FROM user_movie_status u WHERE u.media_id = m.id)
            OR EXISTS (SELECT 1 FROM watch_history w WHERE w.media_id = m.id)
            THEN 0 ELSE 1 END AS rank,
          md5(m.type::text
            || '|' || EXISTS (SELECT 1 FROM shows s WHERE s.media_id = m.id)::text
            || '|' || EXISTS (SELECT 1 FROM movies v WHERE v.media_id = m.id)::text
            || '|' || coalesce((SELECT string_agg(e.provider::text || ':'
                 || e.provider_entity_kind::text || ':' || e.value, ',' ORDER BY e.provider, e.provider_entity_kind, e.value)
               FROM external_ids e WHERE e.media_id = m.id), '')) AS fingerprint
        FROM media_items m
        WHERE (${mediaId ?? null}::text IS NULL OR m.id = ${mediaId ?? null})
          AND NOT EXISTS (SELECT 1 FROM media_canonical_links l
            WHERE l.source_media_id = m.id AND l.status = 'ACTIVE')
          AND (
            (m.type = 'MOVIE' AND EXISTS (SELECT 1 FROM shows s WHERE s.media_id = m.id))
            OR (m.type = 'SHOW' AND EXISTS (SELECT 1 FROM movies v WHERE v.media_id = m.id))
            OR EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
              AND e.provider_entity_kind = (CASE WHEN m.type = 'SHOW' THEN 'MOVIE' ELSE 'SERIES' END)::"ProviderEntityKind")
            OR EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
              AND e.provider IN ('TMDB', 'THE_TVDB', 'IMDB')
              AND e.provider_entity_kind IN ('SERIES', 'MOVIE')
              GROUP BY e.provider, e.provider_entity_kind HAVING count(*) > 1)
          )
      )
      SELECT id, title, rank, fingerprint FROM candidates
      WHERE (${mediaId ?? null}::text IS NOT NULL
          OR stamp IS NULL
          OR stamp ->> 'fingerprint' IS DISTINCT FROM fingerprint
          OR coalesce((stamp ->> 'checkedAt')::timestamptz, 'epoch') < now() - make_interval(days =>
            CASE WHEN stamp ->> 'outcome' = 'failed' THEN ${FAILED_RECHECK_DAYS}::int ELSE ${RECHECK_DAYS}::int END))
        AND (rank, id) > (${Number(rank) || 0}::int, ${id ?? ''})
      ORDER BY rank, id
      LIMIT ${limit}`);
  }

  private async markChecked(target: Target, outcome: SweepOutcome, reason?: string) {
    const marker = JSON.stringify({
      checkedAt: new Date().toISOString(),
      outcome,
      reason: reason?.slice(0, 120) ?? null,
      fingerprint: target.fingerprint,
    });
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE media_items
      SET metadata_provenance = jsonb_set(coalesce(metadata_provenance, '{}'::jsonb),
        '{identitySweep}', ${marker}::jsonb, true)
      WHERE id = ${target.id}`);
  }
}
