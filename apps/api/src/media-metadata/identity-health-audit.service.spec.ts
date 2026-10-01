import { Logger } from '@nestjs/common';
import { safeCronResultSummary } from '../admin/cron-manager.service';
import {
  IDENTITY_AUDIT_RULES_VERSION,
  IdentityHealthAuditService,
} from './identity-health-audit.service';

function setup(rows: Array<Record<string, bigint | number>>) {
  const calls: string[] = [];
  let index = 0;
  const tx = {
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      calls.push(sql);
      return 0;
    }),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      calls.push(sql);
      return [];
    }),
    $queryRaw: jest.fn(async (query: { sql: string }) => {
      calls.push(query.sql);
      return [rows[index++] ?? {}];
    }),
  };
  const prisma = { $transaction: jest.fn(async (fn: any, _options?: any) => fn(tx)) };
  return { service: new IdentityHealthAuditService(prisma as any), prisma, tx, calls };
}

describe('IdentityHealthAuditService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('runs every query inside a read-only transaction with a statement timeout', async () => {
    const f = setup([]);
    await f.service.run();
    expect(f.calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(f.calls[1]).toContain("set_config('statement_timeout'");
    expect(f.tx.$queryRaw).toHaveBeenCalledTimes(6);
    for (const sql of f.calls.slice(2)) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });

  it('flattens bigint counts into camelCase numbers', async () => {
    const f = setup([
      { shows_missing_tmdb: 32907n, anime_missing_tvdb_users: 122n },
      { multi_alias_media: 271n },
    ]);
    const snapshot = await f.service.run();
    expect(snapshot).toMatchObject({
      rulesVersion: IDENTITY_AUDIT_RULES_VERSION,
      showsMissingTmdb: 32907,
      animeMissingTvdbUsers: 122,
      multiAliasMedia: 271,
    });
    expect(typeof snapshot.durationMs).toBe('number');
  });

  it('fits the cron result budget without truncation', async () => {
    const keys = [
      'shows movies shows_missing_tmdb shows_missing_tvdb shows_without_provider_ids anime_missing_tvdb anime_missing_tvdb_users movies_missing_tmdb movies_missing_tmdb_users',
      'multi_alias_media multi_alias_media_users',
      'movie_rows_with_show_structure show_rows_with_movie_structure wrong_kind_alias_media',
      'dup_pairs_general dup_pairs_general_users dup_pairs_general_both_users dup_pairs_anime dup_pairs_anime_users dup_pairs_anime_both_users',
      'shows_without_structure_authority shows_without_structure_authority_users anime_not_anime_tvdb',
      'legacy_unmapped_episodes legacy_unmapped_episodes_users episodes_multi_tvdb_alias canonical_links_active',
    ].map((group) => Object.fromEntries(group.split(' ').map((key) => [key, 9_999_999n] as const)));
    const snapshot = await setup(keys).service.run();
    const stored = safeCronResultSummary(snapshot);
    expect(stored.truncated).toBeUndefined();
    // 27 metrics + rulesVersion + durationMs, all retained.
    expect(Object.keys(stored)).toHaveLength(29);
  });
});

describe('IdentityHealthAuditService admin views', () => {
  function prismaWith(runs: Array<{ result: Record<string, number>; startedAt: Date }>) {
    return {
      cronJob: {
        findMany: jest.fn(async () => [
          {
            id: 'j1',
            name: 'identity_audit',
            label: 'Audit',
            enabled: false,
            schedule: '15 4 * * *',
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
          },
          {
            id: 'j2',
            name: 'identity_backlog',
            label: 'Backlog',
            enabled: false,
            schedule: '30 2 * * *',
            lastRunAt: null,
            lastStatus: null,
            lastError: null,
          },
        ]),
        findUnique: jest.fn(async () => ({ id: 'j1' })),
      },
      cronJobRun: {
        findMany: jest.fn(async ({ where, take }: any) =>
          where.jobId === 'j1' ? runs.slice(0, take) : [],
        ),
        create: jest.fn(async () => ({})),
      },
    };
  }

  it('returns the latest and previous snapshots and every identity job, even unseeded ones', async () => {
    const prisma = prismaWith([
      { result: { dupPairsGeneral: 8013 }, startedAt: new Date('2026-09-30T12:00:00Z') },
      { result: { dupPairsGeneral: 8021 }, startedAt: new Date('2026-09-29T12:00:00Z') },
    ]);
    const overview = await new IdentityHealthAuditService(prisma as any).overview();
    expect(overview.audit.latest).toEqual({ dupPairsGeneral: 8013 });
    expect(overview.audit.previous).toEqual({ dupPairsGeneral: 8021 });
    expect(overview.jobs.map((j) => j.name)).toEqual(['identity_audit', 'identity_maintenance']);
    expect(overview.jobs[1]).toMatchObject({ enabled: false, lastResult: null });
  });

  it('records an on-demand snapshot in the audit job history even when the job is disabled', async () => {
    const prisma: any = prismaWith([]);
    const service = new IdentityHealthAuditService(prisma);
    jest.spyOn(service, 'run').mockResolvedValue({ rulesVersion: 1, durationMs: 42 });
    await service.recordSnapshot();
    expect(prisma.cronJobRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ jobId: 'j1', status: 'success', durationMs: 42 }),
    });
  });

  it('reads sample rows inside a read-only transaction with a bounded limit', async () => {
    const calls: string[] = [];
    const tx = {
      $executeRawUnsafe: jest.fn(async (sql: string) => calls.push(sql)),
      $queryRawUnsafe: jest.fn(async (sql: string, ...args: unknown[]) => {
        calls.push(sql);
        return args.length
          ? [{ mediaId: 'm', title: 'T', type: 'SHOW', users: 3, detail: null, limit: args[0] }]
          : [];
      }),
    };
    const prisma = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const rows: any[] = await new IdentityHealthAuditService(prisma as any).samples(
      'type-mismatch',
      5000,
    );
    expect(calls[0]).toBe('SET TRANSACTION READ ONLY');
    expect(rows[0].limit).toBe(200);
  });
});
