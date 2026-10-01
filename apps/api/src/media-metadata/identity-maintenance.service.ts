import { Injectable, Logger, Optional } from '@nestjs/common';
import { IdentityBacklogService } from './identity-backlog.service';
import { IdentityRepairService } from './identity-repair.service';
import { IdentityRepairSweepService } from './identity-repair-sweep.service';
import { MetadataBackfillService } from './metadata-backfill.service';
import { StructureBackfillService } from './structure-backfill.service';

export interface IdentityMaintenanceOptions {
  mode: 'dry-run' | 'apply';
  repairSweep: boolean;
  backlog: boolean;
  structure: boolean;
  watchforge: boolean;
  /** Wall-clock budget for one run; keep it below the schedule interval. */
  maxMinutes: number;
  /** Upper bound on verified repairs per run (each one may spend WatchForge lookups). */
  sweepBatch: number;
}

/** Row cap per step; the time budget normally ends a step long before this. */
const STEP_ROW_CAP = 1000;
/** Mixed-graph repairs are full re-hydrations + remaps (tens of seconds each). */
const RECONCILE_PER_RUN = 10;
const ANIME_PER_RUN = 25;

/**
 * One scheduled job for the whole identity cleanup, run in short resumable slices:
 *   0. resume metadata follow-ups of applied identity repairs (crash recovery);
 *   1. verified repair of rows with inconsistent ids (identity-repair-sweep);
 *   2. crosswalk backlog: fill missing TMDB/TVDB ids, merge proven duplicates;
 *   3. structure: repair shows whose episodes mix TMDB and TVDB graphs, move anime still on
 *      TMDB episodes to TVDB, then the authority backfill (pick each show's episode-graph
 *      owner and remap episodes).
 * The mixed-graph and anime repairs are small bounded batches; the crosswalk backlog and the
 * authority backfill share what is left of the time budget, and a step with no work left
 * hands its time to the next. Each step resumes from its own cursor in the previous run's result.
 * A failing step is reported and does not stop the others.
 */
@Injectable()
export class IdentityMaintenanceService {
  private readonly logger = new Logger(IdentityMaintenanceService.name);

  constructor(
    @Optional() private readonly identityRepair?: IdentityRepairService,
    @Optional() private readonly sweep?: IdentityRepairSweepService,
    @Optional() private readonly backlog?: IdentityBacklogService,
    @Optional() private readonly structure?: StructureBackfillService,
    @Optional() private readonly metadataBackfill?: MetadataBackfillService,
  ) {}

  async run(
    options: IdentityMaintenanceOptions,
    previous: Record<string, unknown> | null,
  ): Promise<Record<string, string | number | boolean | null>> {
    const end = Date.now() + options.maxMinutes * 60_000;
    const cursor = (key: string) => {
      const value = previous?.[key];
      return typeof value === 'string' && value.length > 0 ? value : null;
    };
    const result: Record<string, string | number | boolean | null> = {
      mode: options.mode,
      sweepCursor: cursor('sweepCursor'),
      backlogCursor: cursor('backlogCursor'),
      structureCursor: cursor('structureCursor'),
      reconcileCursor: cursor('reconcileCursor'),
    };
    const errors: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        errors.push(`${name}: ${message}`.slice(0, 200));
        this.logger.error(`identity maintenance ${name} failed: ${message}`);
      }
    };

    if (options.mode === 'apply' && this.identityRepair)
      await step('follow-ups', async () => {
        const followUps = await this.identityRepair!.resumeFollowUps();
        result.followUpsQueued = followUps.queued;
      });

    if (options.repairSweep && this.sweep)
      await step('repair', async () => {
        const report = await this.sweep!.run({
          mode: options.mode,
          limit: options.sweepBatch,
          cursor: cursor('sweepCursor'),
          deadline: end,
        });
        result.sweepCursor = report.nextCursor;
        result.repairChecked = report.processed;
        result.repaired = report.counts.repaired;
        result.repairBlocked = report.counts.blocked;
        result.repairFailed = report.counts.failed;
        if (report.stopReason?.startsWith('deferred')) result.repairStopped = report.stopReason;
      });

    if (options.structure && this.metadataBackfill) {
      const metadataBackfill = this.metadataBackfill;
      await step('mixed-graphs', async () => {
        const report = await metadataBackfill.reconcileStructures({
          mode: options.mode === 'apply' ? 'repair' : 'report',
          limit: RECONCILE_PER_RUN,
          cursor: cursor('reconcileCursor') ?? undefined,
          scope: 'structural',
        });
        result.reconcileCursor = report.nextCursor;
        result.mixedGraphsChecked = report.processed;
        result.mixedGraphsRepaired = report.repaired;
        // Episodes that could not be mapped are kept as legacy rows with their user data.
        result.mixedGraphEpisodesKeptAsLegacy = report.needsReview;
      });
      // Re-hydration has no dry-run; it only runs when the job applies changes.
      if (options.mode === 'apply')
        await step('anime', async () => {
          const report = await metadataBackfill.rehydrateAnimeFromTvdb(ANIME_PER_RUN);
          result.animeMovedToTvdb = report.succeeded;
          result.animeFailed = report.failed;
        });
    }

    if (options.backlog && this.backlog) {
      // Half of what is left, unless the structure step is off; unused time rolls over.
      const remaining = end - Date.now();
      const deadline = options.structure ? Date.now() + remaining / 2 : end;
      await step('backlog', async () => {
        const report = await this.backlog!.run({
          mode: options.mode,
          limit: STEP_ROW_CAP,
          cursor: cursor('backlogCursor'),
          watchforge: options.watchforge,
          deadline,
        });
        result.backlogCursor = report.nextCursor;
        result.backlogChecked = report.processed;
        result.idsAttached = report.counts.attach;
        result.duplicatesMerged = report.counts.consolidate;
        result.backlogConflicts = report.counts.conflict + report.counts['ambiguous-owner'];
        result.backlogDeferred = report.counts.deferred;
      });
    }

    if (options.structure && this.structure)
      await step('structure', async () => {
        const report = await this.structure!.run({
          mode: options.mode,
          limit: STEP_ROW_CAP,
          cursor: cursor('structureCursor'),
          deadline: end,
        });
        result.structureCursor = report.nextCursor;
        result.structureChecked = report.processed;
        result.structureDecided = report.counts.decided;
        result.episodesRemapped = report.counts.migrated;
        result.structureBlocked = report.counts.blocked;
        result.tvdbOnlyRefreshes = report.counts['tvdb-only-refresh'];
        result.structureFailed = report.counts.failed;
      });

    // CronManager records a run with failed steps as failed, keeping the cursors above.
    if (errors.length) result.failedSteps = errors.join(' | ').slice(0, 500);
    return result;
  }
}
