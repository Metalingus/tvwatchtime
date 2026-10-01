import { Logger } from '@nestjs/common';
import { ProviderThrottled } from './providers/shared/provider-http';
import { StructureBackfillService } from './structure-backfill.service';

function setup(
  targets: Array<{ id: string; priority?: number; has_tmdb?: boolean; has_tvdb?: boolean }>,
) {
  const prisma: any = {
    $queryRaw: jest.fn(async () =>
      targets.map((t) => ({
        id: t.id,
        title: t.id,
        priority: t.priority ?? 0,
        has_tmdb: t.has_tmdb ?? true,
        has_tvdb: t.has_tvdb ?? true,
      })),
    ),
    $executeRaw: jest.fn(async () => 1),
  };
  const meta: any = { evaluateShowStructureAuthority: jest.fn() };
  const hydration: any = { enqueueIdentityRefresh: jest.fn(async () => undefined) };
  return {
    service: new StructureBackfillService(prisma, meta, hydration),
    meta,
    hydration,
    prisma,
  };
}

describe('StructureBackfillService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('evaluates without writing in dry-run and classifies each outcome', async () => {
    const f = setup([
      { id: 'same' },
      { id: 'decided' },
      { id: 'remap' },
      { id: 'blocked' },
      { id: 'later' },
    ]);
    f.meta.evaluateShowStructureAuthority
      .mockResolvedValueOnce({ evaluated: true, changed: false, blocked: false })
      .mockResolvedValueOnce({ evaluated: true, changed: true, blocked: false })
      .mockResolvedValueOnce({ evaluated: true, changed: true, blocked: false, preview: {} })
      .mockResolvedValueOnce({ evaluated: true, changed: true, blocked: true })
      .mockResolvedValueOnce({ evaluated: true, changed: false, blocked: false, deferred: true });
    const report = await f.service.run({ mode: 'dry-run' });
    expect(f.meta.evaluateShowStructureAuthority).toHaveBeenCalledWith('same', { dryRun: true });
    expect(report.counts).toMatchObject({
      unchanged: 1,
      decided: 1,
      migrated: 1,
      blocked: 1,
      deferred: 1,
    });
  });

  it('applies through the same evaluation with writes enabled', async () => {
    const f = setup([{ id: 'show' }]);
    f.meta.evaluateShowStructureAuthority.mockResolvedValue({
      evaluated: true,
      changed: true,
      blocked: false,
    });
    await f.service.run({ mode: 'apply' });
    expect(f.meta.evaluateShowStructureAuthority).toHaveBeenCalledWith('show', { dryRun: false });
  });

  it('refreshes TVDB-only shows from TVDB only when applying', async () => {
    const dry = setup([{ id: 'tvdb-only', has_tmdb: false }]);
    expect((await dry.service.run({ mode: 'dry-run' })).counts['tvdb-only-refresh']).toBe(1);
    expect(dry.hydration.enqueueIdentityRefresh).not.toHaveBeenCalled();
    const apply = setup([{ id: 'tvdb-only', has_tmdb: false }]);
    await apply.service.run({ mode: 'apply' });
    expect(apply.hydration.enqueueIdentityRefresh).toHaveBeenCalledWith(
      'tvdb-only',
      'structure-backfill',
    );
    expect(apply.meta.evaluateShowStructureAuthority).not.toHaveBeenCalled();
  });

  it('stamps each evaluated show in apply mode only, so unchanged candidates are not re-evaluated every pass', async () => {
    const dry = setup([{ id: 'show' }]);
    dry.meta.evaluateShowStructureAuthority.mockResolvedValue({ evaluated: true, blocked: true });
    await dry.service.run({ mode: 'dry-run' });
    expect(dry.prisma.$executeRaw).not.toHaveBeenCalled();

    const apply = setup([{ id: 'show' }]);
    apply.meta.evaluateShowStructureAuthority.mockResolvedValue({ evaluated: true, blocked: true });
    await apply.service.run({ mode: 'apply' });
    expect(apply.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = apply.prisma.$executeRaw.mock.calls[0][0];
    expect(sql.strings.join('?')).toContain('{structureBackfill}');
    expect(sql.values[0]).toContain('"outcome":"blocked"');
    // The candidate query skips recently stamped shows unless one title is requested.
    expect(apply.prisma.$queryRaw.mock.calls[0][0].strings.join('?')).toContain(
      "'structureBackfill' ->> 'checkedAt'",
    );
  });

  it('stops before the next show once the time budget is spent and keeps the cursor', async () => {
    const f = setup([{ id: 'a' }, { id: 'b' }]);
    f.meta.evaluateShowStructureAuthority.mockResolvedValue({ evaluated: true, changed: false });
    const report = await f.service.run({ mode: 'dry-run', limit: 2, deadline: Date.now() - 1 });
    expect(report).toMatchObject({ processed: 0, stoppedEarly: true });
    expect(f.meta.evaluateShowStructureAuthority).not.toHaveBeenCalled();
  });

  it('stops on provider throttling and resumes at the last processed show', async () => {
    const f = setup([
      { id: 'a', priority: 0 },
      { id: 'b', priority: 0 },
    ]);
    f.meta.evaluateShowStructureAuthority
      .mockResolvedValueOnce({ evaluated: true, changed: false, blocked: false })
      .mockRejectedValueOnce(new ProviderThrottled('tvdb', 1000));
    const report = await f.service.run({ mode: 'dry-run', limit: 2 });
    expect(report).toMatchObject({ processed: 1, stoppedEarly: true, nextCursor: '0:a' });
  });

  it('records unexpected failures and keeps going', async () => {
    const f = setup([{ id: 'a' }, { id: 'b' }]);
    f.meta.evaluateShowStructureAuthority
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ evaluated: true, changed: false, blocked: false });
    const report = await f.service.run({ mode: 'dry-run' });
    expect(report.counts).toMatchObject({ failed: 1, unchanged: 1 });
    expect(report.samples[0]).toMatchObject({ mediaId: 'a', outcome: 'failed', detail: 'boom' });
  });
});
