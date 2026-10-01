import { Logger } from '@nestjs/common';
import { gradeShowCrosswalk, IdentityBacklogService } from './identity-backlog.service';
import { ProviderError } from './providers/shared/provider-errors';
import { ProviderThrottled } from './providers/shared/provider-http';

describe('gradeShowCrosswalk', () => {
  const tmdb = (tvdbId: number | null, imdbId: string | null = null) => ({
    tmdbId: 10,
    tvdbId,
    imdbId,
  });
  const tvdb = (tmdbId: number | null, imdbId: string | null = null) => ({
    tmdbId,
    tvdbId: 20,
    imdbId,
  });

  it('is tier A only when each provider names the other', () => {
    expect(gradeShowCrosswalk(tmdb(20), tvdb(10))).toBe('A');
  });
  it('is tier B when one side names the other and both report the same IMDb id', () => {
    expect(gradeShowCrosswalk(tmdb(20, 'tt1'), tvdb(null, 'TT1'))).toBe('B');
    expect(gradeShowCrosswalk(tmdb(null, 'tt1'), tvdb(10, 'tt1'))).toBe('B');
  });
  it('rejects a one-sided claim without IMDb agreement', () => {
    expect(gradeShowCrosswalk(tmdb(20), tvdb(null))).toBeNull();
    expect(gradeShowCrosswalk(tmdb(20, 'tt1'), tvdb(null, 'tt2'))).toBeNull();
  });
  it('never overrules an explicit contradiction', () => {
    expect(gradeShowCrosswalk(tmdb(99, 'tt1'), tvdb(10, 'tt1'))).toBeNull();
    expect(gradeShowCrosswalk(tmdb(20, 'tt1'), tvdb(77, 'tt1'))).toBeNull();
  });
});

type Row = { id: string; type: 'SHOW' | 'MOVIE'; ids: string[]; users?: boolean; anime?: boolean };

function setup(rows: Row[], owners: Record<string, string> = {}) {
  const prisma: any = {
    $queryRaw: jest.fn(async () =>
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.id,
        classification: r.anime ? 'ANIME' : 'GENERAL',
        has_users: r.users ?? true,
        ids: r.ids,
      })),
    ),
    $executeRaw: jest.fn(async () => 1),
    externalId: {
      findFirst: jest.fn(async ({ where }: any) => {
        const owner = owners[`${where.provider}:${where.value}`];
        return owner ? { mediaId: owner } : null;
      }),
    },
    mediaCanonicalLink: { findUnique: jest.fn(async () => null) },
    mediaItem: {
      findMany: jest.fn(async ({ where }: any) =>
        rows
          .concat(
            Object.values(owners)
              .filter((id) => !rows.some((r) => r.id === id))
              .map((id) => ({
                id,
                type: 'SHOW' as const,
                ids: Object.entries(owners)
                  .filter(([, owner]) => owner === id)
                  .map(([key]) => key),
              })),
          )
          .filter((r) => where.id.in.includes(r.id))
          .map((r) => ({
            id: r.id,
            type: r.type,
            contentClassification: r.anime ? 'ANIME' : 'GENERAL',
            externalIds: r.ids.map((key) => {
              const [provider, value] = key.split(':');
              return { provider, value };
            }),
            show: r.type === 'SHOW' ? { structureProvider: null, structureReason: null } : null,
            movie: null,
          })),
      ),
    },
    adminAuditLog: { create: jest.fn(async () => ({})) },
  };
  const tmdb: any = {
    findByExternalIdStrict: jest.fn(async () => ({ show: { tmdbId: 10 }, movie: null })),
    getShowRoutingProfile: jest.fn(async () => ({
      tmdbId: 10,
      tvdbId: 20,
      imdbId: 'tt1',
      genreIds: [18],
      keywords: [],
    })),
    getShow: jest.fn(async () => ({ seasons: [{ number: 1, isSpecial: false, episodes: [{}] }] })),
  };
  const tvdb: any = {
    getShowIdentity: jest.fn(async () => ({ tvdbId: 20, tmdbId: 10, imdbId: 'tt1' })),
    getShow: jest.fn(async () => ({ seasons: [{ number: 1, isSpecial: false, episodes: [{}] }] })),
  };
  const reconciler: any = { attachExternalId: jest.fn(async () => undefined) };
  const canonical: any = {
    identityFamily: jest.fn(async (_ids: string[], target: string, options: any) =>
      options.mode === 'dry-run'
        ? { status: 'ready', fingerprint: 'fp', targetMediaId: target }
        : { status: 'applied', activated: 1, targetMediaId: target },
    ),
  };
  const service = new IdentityBacklogService(prisma, tmdb, tvdb, reconciler, canonical);
  return { service, prisma, tmdb, tvdb, reconciler, canonical };
}

describe('IdentityBacklogService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'log').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('dry-run proposes attaching a tier-A crosswalk without writing anything', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }]);
    const report = await f.service.run({ mode: 'dry-run' });
    expect(report.counts.attach).toBe(1);
    expect(report.tiers.A).toBe(1);
    expect(f.reconciler.attachExternalId).not.toHaveBeenCalled();
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('apply attaches the proven ids and marks the row checked', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }]);
    await f.service.run({ mode: 'apply' });
    expect(f.reconciler.attachExternalId).toHaveBeenCalledWith('tvdb-row', {
      provider: 'TMDB',
      providerEntityKind: 'SERIES',
      value: '10',
    });
    expect(f.reconciler.attachExternalId).toHaveBeenCalledWith('tvdb-row', {
      provider: 'IMDB',
      providerEntityKind: 'SERIES',
      value: 'tt1',
    });
    expect(f.prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('consolidates a proven duplicate onto the TMDB row for general TV', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }], {
      'TMDB:10': 'tmdb-row',
    });
    const dry = await f.service.run({ mode: 'dry-run' });
    expect(dry.counts.consolidate).toBe(1);
    expect(f.canonical.identityFamily).toHaveBeenCalledTimes(1);
    expect(f.canonical.identityFamily).toHaveBeenCalledWith(
      ['tvdb-row', 'tmdb-row'],
      'tmdb-row',
      expect.objectContaining({ mode: 'dry-run', canonical: 'tmdb' }),
    );

    const g = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }], {
      'TMDB:10': 'tmdb-row',
    });
    await g.service.run({ mode: 'apply' });
    expect(g.canonical.identityFamily).toHaveBeenLastCalledWith(
      ['tvdb-row', 'tmdb-row'],
      'tmdb-row',
      expect.objectContaining({ mode: 'repair', fingerprint: 'fp' }),
    );
    expect(g.prisma.adminAuditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: 'identity_backlog_consolidate' }),
      }),
    );
  });

  it('keeps anime on the TVDB row', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'], anime: true }], {
      'TMDB:10': 'tmdb-row',
    });
    await f.service.run({ mode: 'dry-run' });
    expect(f.canonical.identityFamily).toHaveBeenCalledWith(
      expect.anything(),
      'tvdb-row',
      expect.objectContaining({ canonical: 'tvdb' }),
    );
  });

  it('reports a provider contradiction and changes nothing', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }]);
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      tvdbId: 99,
      imdbId: 'tt1',
      genreIds: [],
      keywords: [],
    });
    const report = await f.service.run({ mode: 'apply' });
    expect(report.counts.conflict).toBe(1);
    expect(f.reconciler.attachExternalId).not.toHaveBeenCalled();
    expect(f.canonical.identityFamily).not.toHaveBeenCalled();
  });

  it('reports a dead TVDB alias instead of guessing a replacement', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }]);
    f.tvdb.getShowIdentity.mockRejectedValue(new ProviderError('not_found', 'tvdb 404', 404));
    const report = await f.service.run({ mode: 'dry-run' });
    expect(report.counts['dead-alias']).toBe(1);
    expect(f.tmdb.findByExternalIdStrict).not.toHaveBeenCalled();
  });

  it('never touches rows that already carry several aliases for one provider', async () => {
    const f = setup([{ id: 'multi', type: 'SHOW', ids: ['THE_TVDB:20', 'THE_TVDB:21'] }]);
    const report = await f.service.run({ mode: 'apply' });
    expect(report.counts.skipped).toBe(1);
    expect(f.tvdb.getShowIdentity).not.toHaveBeenCalled();
  });

  it('stops early on provider throttling and resumes from the last processed row', async () => {
    const f = setup([
      { id: 'a', type: 'SHOW', ids: ['THE_TVDB:20'] },
      { id: 'b', type: 'SHOW', ids: ['THE_TVDB:21'] },
    ]);
    f.tvdb.getShowIdentity
      .mockResolvedValueOnce({ tvdbId: 20, tmdbId: 10, imdbId: 'tt1' })
      .mockRejectedValueOnce(new ProviderThrottled('tvdb', 1000));
    const report = await f.service.run({ mode: 'dry-run', limit: 2 });
    expect(report.stoppedEarly).toBe(true);
    expect(report.processed).toBe(1);
    expect(report.nextCursor).toBe('0:a');
  });

  it('refreshes a stale survivor graph and keeps the row eligible for the next pass', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }], {
      'TMDB:10': 'tmdb-row',
    });
    const hydration = { enqueueIdentityRefresh: jest.fn(async () => undefined) };
    (f.service as any).hydration = hydration;
    f.canonical.identityFamily.mockResolvedValue({
      status: 'structure-required',
      reason: 'target-graph-is-stale',
      fingerprint: '0123456789abcdef-rest',
    });
    const report = await f.service.run({ mode: 'apply' });
    expect(report.counts.blocked).toBe(1);
    expect(hydration.enqueueIdentityRefresh).toHaveBeenCalledWith(
      'tmdb-row',
      'backlog-0123456789abcdef',
    );
    expect(f.prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('never consolidates when the canonicalization preview is blocked', async () => {
    const f = setup([{ id: 'tvdb-row', type: 'SHOW', ids: ['THE_TVDB:20'] }], {
      'TMDB:10': 'tmdb-row',
    });
    f.canonical.identityFamily.mockResolvedValue({
      status: 'blocked',
      reason: 'unverified-or-conflicting-alias',
    });
    const report = await f.service.run({ mode: 'apply' });
    expect(report.counts.blocked).toBe(1);
    expect(f.canonical.identityFamily).toHaveBeenCalledTimes(1);
    expect(f.prisma.adminAuditLog.create).not.toHaveBeenCalled();
  });
});
