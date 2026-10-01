import { Logger } from '@nestjs/common';
import { IdentityVerificationDeferred } from './identity-repair.service';
import { IdentityRepairSweepService } from './identity-repair-sweep.service';

function setup(targets: Array<{ id: string; rank?: number }>) {
  const prisma: any = {
    $queryRaw: jest.fn(async () =>
      targets.map((t) => ({ id: t.id, title: t.id, rank: t.rank ?? 0, fingerprint: `fp-${t.id}` })),
    ),
    $executeRaw: jest.fn(async () => 1),
  };
  const repair: any = { repairAutomatically: jest.fn(), preview: jest.fn() };
  const hydration: any = { enqueueIdentityRefresh: jest.fn(async () => undefined) };
  return {
    service: new IdentityRepairSweepService(prisma, repair, hydration),
    prisma,
    repair,
    hydration,
  };
}

const repaired = (mediaId: string) => ({
  repaired: true,
  mediaIds: [mediaId],
  followUps: [{ mediaId, operationId: 'op-1' }],
});

describe('IdentityRepairSweepService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('applies verified plans, queues their metadata follow-ups and stamps every checked row', async () => {
    const f = setup([{ id: 'split-me' }, { id: 'benign' }, { id: 'unproven' }]);
    f.repair.repairAutomatically
      .mockResolvedValueOnce(repaired('split-me'))
      .mockResolvedValueOnce({ repaired: true, mediaIds: ['benign'], followUps: [] })
      .mockResolvedValueOnce({
        repaired: false,
        reason: 'choose-current-identity',
        mediaIds: ['unproven'],
        followUps: [],
      });

    const report = await f.service.run({ mode: 'apply', limit: 10 });

    expect(report.counts).toMatchObject({ repaired: 1, verified: 1, blocked: 1 });
    expect(report.reasons).toEqual({ 'choose-current-identity': 1 });
    expect(f.hydration.enqueueIdentityRefresh).toHaveBeenCalledWith(
      'split-me',
      'identity-sweep',
      'op-1',
    );
    // One stamp per row, carrying the alias fingerprint so unchanged rows skip rechecks.
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(3);
    expect(f.prisma.$executeRaw.mock.calls[2][0].values[0]).toContain(
      '"fingerprint":"fp-unproven"',
    );
    expect(report.nextCursor).toBeNull(); // short page = pass complete
  });

  it('stops on a quota/outage deferral without stamping, and resumes from the last row', async () => {
    const f = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    f.repair.repairAutomatically
      .mockResolvedValueOnce(repaired('a'))
      .mockRejectedValueOnce(new IdentityVerificationDeferred('quota', 60_000));

    const report = await f.service.run({ mode: 'apply', limit: 3 });

    expect(report).toMatchObject({ processed: 1, stoppedEarly: true, nextCursor: '0:a' });
    expect(report.stopReason).toBe('deferred:quota');
    expect(f.repair.repairAutomatically).toHaveBeenCalledTimes(2);
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('treats disabled WatchForge as a pause, not as a blocked row', async () => {
    const f = setup([{ id: 'a' }]);
    f.repair.repairAutomatically.mockResolvedValue({
      repaired: false,
      reason: 'disabled',
      mediaIds: ['a'],
      followUps: [],
    });

    const report = await f.service.run({ mode: 'apply' });

    expect(report).toMatchObject({ processed: 0, stoppedEarly: true });
    expect(report.counts.blocked).toBe(0);
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('reports an applied split whose next step is unproven as a partial repair', async () => {
    const f = setup([{ id: 'movie' }]);
    f.repair.repairAutomatically.mockResolvedValue({
      repaired: false,
      reason: 'conflicting-alias-partition-unproven',
      mediaIds: ['movie', 'new-show'],
      followUps: [{ mediaId: 'new-show', operationId: 'op-2' }],
    });

    const report = await f.service.run({ mode: 'apply' });

    expect(report.counts).toMatchObject({ repaired: 1, blocked: 0 });
    expect(report.samples[0].reason).toBe('partial: conflicting-alias-partition-unproven');
    expect(f.hydration.enqueueIdentityRefresh).toHaveBeenCalledWith(
      'new-show',
      'identity-sweep',
      'op-2',
    );
  });

  it('records unexpected errors as failed and keeps going', async () => {
    const f = setup([{ id: 'a' }, { id: 'b' }]);
    f.repair.repairAutomatically
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(repaired('b'));

    const report = await f.service.run({ mode: 'apply' });

    expect(report.counts).toMatchObject({ failed: 1, repaired: 1 });
    expect(report.samples[0]).toMatchObject({ mediaId: 'a', outcome: 'failed', reason: 'boom' });
  });

  it('previews without applying or stamping in dry-run', async () => {
    const f = setup([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    f.repair.preview
      .mockResolvedValueOnce({ status: 'ready', action: 'partition' })
      .mockResolvedValueOnce({ status: 'ready', action: 'refresh' })
      .mockResolvedValueOnce({ status: 'blocked', reason: 'protected-data-needs-review' });

    const report = await f.service.run({ mode: 'dry-run' });

    expect(f.repair.repairAutomatically).not.toHaveBeenCalled();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ repaired: 1, verified: 1, blocked: 1 });
    expect(report.samples[0]).toMatchObject({ mediaId: 'a', reason: 'would-partition' });
  });

  it('stops before the next row once the time budget is spent', async () => {
    const f = setup([{ id: 'a' }]);
    const report = await f.service.run({ mode: 'apply', deadline: Date.now() - 1, cursor: '0:x' });
    expect(report).toMatchObject({ processed: 0, stoppedEarly: true, nextCursor: '0:x' });
    expect(f.repair.repairAutomatically).not.toHaveBeenCalled();
  });

  it('selects type mismatches, wrong-kind and multi-alias rows, skipping unchanged stamped rows', async () => {
    const f = setup([]);
    await f.service.run({ mode: 'apply' });
    const sql = f.prisma.$queryRaw.mock.calls[0][0].strings.join('?');
    expect(sql).toContain("m.type = 'MOVIE' AND EXISTS (SELECT 1 FROM shows");
    expect(sql).toContain('HAVING count(*) > 1');
    expect(sql).toContain("stamp ->> 'fingerprint' IS DISTINCT FROM fingerprint");
    expect(sql).toContain("l.status = 'ACTIVE'");
  });
});
