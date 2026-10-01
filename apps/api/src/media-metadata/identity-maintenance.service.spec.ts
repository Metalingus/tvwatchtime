import { Logger } from '@nestjs/common';
import {
  IdentityMaintenanceService,
  IdentityMaintenanceOptions,
} from './identity-maintenance.service';

const options = (over: Partial<IdentityMaintenanceOptions> = {}): IdentityMaintenanceOptions => ({
  mode: 'apply',
  repairSweep: true,
  backlog: true,
  structure: true,
  watchforge: true,
  maxMinutes: 25,
  sweepBatch: 25,
  ...over,
});

function setup() {
  const identityRepair: any = { resumeFollowUps: jest.fn(async () => ({ queued: 2 })) };
  const sweep: any = {
    run: jest.fn(async () => ({
      processed: 3,
      nextCursor: '0:s3',
      counts: { repaired: 2, verified: 0, blocked: 1, deferred: 0, failed: 0 },
    })),
  };
  const backlog: any = {
    run: jest.fn(async () => ({
      processed: 40,
      nextCursor: '1:b40',
      counts: { attach: 5, consolidate: 2, conflict: 1, 'ambiguous-owner': 1, deferred: 0 },
    })),
  };
  const structure: any = {
    run: jest.fn(async () => ({
      processed: 30,
      nextCursor: null,
      counts: { decided: 20, migrated: 3, blocked: 2, 'tvdb-only-refresh': 4, failed: 1 },
    })),
  };
  const metadataBackfill: any = {
    reconcileStructures: jest.fn(async () => ({
      processed: 4,
      repaired: 3,
      needsReview: 1,
      nextCursor: 'r4',
    })),
    rehydrateAnimeFromTvdb: jest.fn(async () => ({ succeeded: 2, failed: 0 })),
  };
  const service = new IdentityMaintenanceService(
    identityRepair,
    sweep,
    backlog,
    structure,
    metadataBackfill,
  );
  return { service, identityRepair, sweep, backlog, structure, metadataBackfill };
}

describe('IdentityMaintenanceService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('runs every step from its own cursor and reports flat counts with the next cursors', async () => {
    const f = setup();
    const result = await f.service.run(options(), {
      sweepCursor: '0:s0',
      backlogCursor: '1:b0',
      structureCursor: '2:x',
      reconcileCursor: 'r0',
    });

    expect(f.identityRepair.resumeFollowUps).toHaveBeenCalled();
    expect(f.sweep.run).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'apply', limit: 25, cursor: '0:s0' }),
    );
    expect(f.metadataBackfill.reconcileStructures).toHaveBeenCalledWith({
      mode: 'repair',
      limit: 10,
      cursor: 'r0',
      scope: 'structural',
    });
    expect(f.backlog.run).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '1:b0', watchforge: true }),
    );
    expect(f.structure.run).toHaveBeenCalledWith(expect.objectContaining({ cursor: '2:x' }));
    expect(result).toMatchObject({
      mode: 'apply',
      followUpsQueued: 2,
      sweepCursor: '0:s3',
      repaired: 2,
      repairBlocked: 1,
      reconcileCursor: 'r4',
      mixedGraphsRepaired: 3,
      animeMovedToTvdb: 2,
      backlogCursor: '1:b40',
      idsAttached: 5,
      duplicatesMerged: 2,
      backlogConflicts: 2,
      structureCursor: null,
      structureDecided: 20,
      episodesRemapped: 3,
    });
    expect(result.failedSteps).toBeUndefined();
    // Every value is a scalar, so the whole result survives the run-history size budget.
    for (const value of Object.values(result))
      expect(['string', 'number', 'boolean'].includes(typeof value) || value === null).toBe(true);
  });

  it('splits the remaining time budget between the backlog and the structure backfill', async () => {
    const f = setup();
    const started = Date.now();
    await f.service.run(options({ maxMinutes: 20 }), null);
    const backlogDeadline = f.backlog.run.mock.calls[0][0].deadline;
    const structureDeadline = f.structure.run.mock.calls[0][0].deadline;
    expect(backlogDeadline).toBeLessThan(structureDeadline);
    expect(structureDeadline).toBeGreaterThanOrEqual(started + 20 * 60_000);
    expect(structureDeadline).toBeLessThanOrEqual(Date.now() + 20 * 60_000);
    // With the structure step off, the backlog gets the whole budget.
    const g = setup();
    await g.service.run(options({ structure: false, maxMinutes: 20 }), null);
    expect(g.backlog.run.mock.calls[0][0].deadline).toBeGreaterThanOrEqual(started + 20 * 60_000);
    expect(g.structure.run).not.toHaveBeenCalled();
  });

  it('dry-run writes nothing: no follow-ups, report-only reconcile, no anime re-hydration', async () => {
    const f = setup();
    await f.service.run(options({ mode: 'dry-run' }), null);
    expect(f.identityRepair.resumeFollowUps).not.toHaveBeenCalled();
    expect(f.metadataBackfill.reconcileStructures).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'report' }),
    );
    expect(f.metadataBackfill.rehydrateAnimeFromTvdb).not.toHaveBeenCalled();
    expect(f.sweep.run).toHaveBeenCalledWith(expect.objectContaining({ mode: 'dry-run' }));
  });

  it('keeps going when a step fails and keeps that step’s previous cursor', async () => {
    const f = setup();
    f.backlog.run.mockRejectedValue(new Error('db timeout'));
    const result = await f.service.run(options(), { backlogCursor: '0:keep' });
    expect(result.backlogCursor).toBe('0:keep');
    expect(result.failedSteps).toBe('backlog: db timeout');
    expect(f.structure.run).toHaveBeenCalled();
  });

  it('skips disabled steps and carries their cursors forward', async () => {
    const f = setup();
    const result = await f.service.run(options({ repairSweep: false, backlog: false }), {
      sweepCursor: '0:s9',
      backlogCursor: '1:b9',
    });
    expect(f.sweep.run).not.toHaveBeenCalled();
    expect(f.backlog.run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ sweepCursor: '0:s9', backlogCursor: '1:b9' });
  });
});
