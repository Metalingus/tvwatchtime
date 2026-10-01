import { ConflictException } from '@nestjs/common';
import { ExternalProvider as P, ProviderEntityKind as K } from '@tvwatch/shared';
import { StreamingChartsService, streamingTopRailKey } from './streaming-charts.service';

const movie = {
  kind: 'MOVIE',
  tmdbId: 1,
  imdbId: 'tt1',
  title: 'Movie',
  year: 2026,
  optionTypes: ['subscription'],
};
const series = {
  kind: 'SHOW',
  tmdbId: 10,
  imdbId: 'tt10',
  title: 'Show',
  year: 2025,
  optionTypes: ['subscription'],
};

function fixture(items: any[] = [movie, series]) {
  const owners = new Map<string, string>();
  const meta: any = {
    findMediaByExternal: jest.fn(async (provider: string, value: string, kind: string) => {
      const id = owners.get(`${provider}:${kind}:${value}`);
      return id ? { id } : null;
    }),
    lightUpsertMovie: jest.fn(async () => 'new-movie'),
    lightUpsertShow: jest.fn(async () => 'new-show'),
  };
  const reconciler: any = {
    creationIdentities: jest.fn(async () => [
      { provider: P.IMDB, providerEntityKind: K.SERIES, value: 'tt10' },
      { provider: P.TMDB, providerEntityKind: K.SERIES, value: '10' },
      { provider: P.THE_TVDB, providerEntityKind: K.SERIES, value: '900' },
    ]),
    attachExternalId: jest.fn(async () => undefined),
    requestIdentityRepair: jest.fn(async () => undefined),
  };
  const tmdb: any = {
    getMovieRoutingProfile: jest.fn(async () => ({
      tmdbId: 1,
      title: 'Movie',
      releaseYear: 2026,
      imdbId: 'tt1',
    })),
    getShowRoutingProfile: jest.fn(async () => ({ tmdbId: 10, imdbId: 'tt10' })),
  };
  const motn: any = {
    topShows: jest.fn(async () => ({ items, dropped: 2 })),
    configured: jest.fn(async () => true),
  };
  const prisma: any = {
    externalId: { findMany: jest.fn(async () => []) },
    show: { findMany: jest.fn(async () => []) },
    hydrationJob: { count: jest.fn(async () => 1) },
  };
  const redis: any = {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    del: jest.fn(async () => undefined),
  };
  const service = new StreamingChartsService(prisma, redis, motn, meta, reconciler, tmdb);
  return { service, meta, reconciler, tmdb, motn, prisma, owners };
}

describe('StreamingChartsService.collect', () => {
  it('creates missing titles through the verified crosswalk, never by title', async () => {
    const f = fixture();
    const out = await f.service.collect('US', 'netflix', { watchforge: true });
    expect(out).toMatchObject({ created: 2, existing: 0, skipped: 0, dropped: 2 });
    expect(out.items.map((i) => [i.rank, i.mediaType, i.mediaId, i.status])).toEqual([
      [1, 'MOVIE', 'new-movie', 'pending'],
      [2, 'SHOW', 'new-show', 'pending'],
    ]);
    expect(f.reconciler.creationIdentities).toHaveBeenCalledWith(
      { provider: P.IMDB, providerEntityKind: K.SERIES, value: 'tt10' },
      P.THE_TVDB,
      { verifyTvdbLink: true, watchforgeLane: 'repair' },
    );
    expect(f.meta.lightUpsertShow).toHaveBeenCalledWith(
      { tmdbId: 10, title: 'Show', year: 2025 },
      { verifyTvdbLink: true, watchforgeLane: 'repair' },
    );
    // Verified bundle aliases the new row lacks are attached through the guarded path.
    expect(f.reconciler.attachExternalId).toHaveBeenCalledWith('new-show', {
      provider: P.THE_TVDB,
      providerEntityKind: K.SERIES,
      value: '900',
    });
  });

  it('uses an existing row by TMDB or IMDb id without any provider call', async () => {
    const f = fixture([series, movie]);
    f.owners.set(`${P.IMDB}:${K.SERIES}:tt10`, 'show-row');
    f.owners.set(`${P.TMDB}:${K.MOVIE}:1`, 'movie-row');
    const out = await f.service.collect('US', 'hbo', { watchforge: true });
    expect(out.items.map((i) => [i.mediaId, i.created])).toEqual([
      ['show-row', false],
      ['movie-row', false],
    ]);
    expect(f.reconciler.creationIdentities).not.toHaveBeenCalled();
    expect(f.tmdb.getMovieRoutingProfile).not.toHaveBeenCalled();
    expect(f.reconciler.attachExternalId).not.toHaveBeenCalled();
  });

  it('finds a TVDB-only row through the crosswalk instead of creating a duplicate', async () => {
    const f = fixture([series]);
    f.owners.set(`${P.THE_TVDB}:${K.SERIES}:900`, 'tvdb-row');
    const out = await f.service.collect('US', 'hbo', { watchforge: false });
    expect(out.items[0]).toMatchObject({ mediaId: 'tvdb-row', created: false, status: 'pending' });
    expect(f.meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(f.reconciler.creationIdentities).toHaveBeenCalledWith(expect.anything(), P.THE_TVDB, {
      verifyTvdbLink: true,
      watchforgeLane: null,
    });
  });

  it('shows a deterministic row for catalog duplicates and queues them for repair', async () => {
    const f = fixture([series, movie]);
    // Show: TMDB row vs IMDb row, no TVDB-owned row → the chart's TMDB row.
    f.owners.set(`${P.TMDB}:${K.SERIES}:10`, 'tmdb-row');
    f.owners.set(`${P.IMDB}:${K.SERIES}:tt10`, 'imdb-row');
    // Movie: TMDB row vs IMDb row → the TMDB row (movies are TMDB-owned).
    f.owners.set(`${P.TMDB}:${K.MOVIE}:1`, 'movie-a');
    f.owners.set(`${P.IMDB}:${K.MOVIE}:tt1`, 'movie-b');
    const out = await f.service.collect('US', 'disney', { watchforge: true });
    expect(out.items.map((i) => [i.mediaId, i.status])).toEqual([
      ['tmdb-row', 'pending'],
      ['movie-a', 'pending'],
    ]);
    expect(out).toMatchObject({ duplicates: 2, skipped: 0 });
    for (const id of ['tmdb-row', 'imdb-row', 'movie-a', 'movie-b'])
      expect(f.reconciler.requestIdentityRepair).toHaveBeenCalledWith(id);
    expect(f.reconciler.attachExternalId).not.toHaveBeenCalled();
  });

  it('prefers the duplicate whose structure the authority already gave to TVDB', async () => {
    const f = fixture([series]);
    f.reconciler.creationIdentities.mockResolvedValue([
      { provider: P.TMDB, providerEntityKind: K.SERIES, value: '10' },
      { provider: P.THE_TVDB, providerEntityKind: K.SERIES, value: '900' },
    ]);
    f.owners.set(`${P.THE_TVDB}:${K.SERIES}:900`, 'tvdb-row');
    f.prisma.show.findMany.mockResolvedValue([
      { mediaId: 'tvdb-row', structureProvider: 'TVDB', structureReason: 'GENERAL_TVDB' },
    ]);
    // TMDB row only appears once the crosswalk has run (no direct TMDB/IMDb owner).
    f.meta.findMediaByExternal.mockImplementation(async (provider: string, value: string) =>
      provider === P.THE_TVDB
        ? { id: 'tvdb-row' }
        : provider === P.TMDB && value === '10' && f.reconciler.creationIdentities.mock.calls.length
          ? { id: 'tmdb-row' }
          : null,
    );
    const out = await f.service.collect('US', 'netflix', { watchforge: false });
    expect(out.items[0]).toMatchObject({ mediaId: 'tvdb-row' });
  });

  it('skips a TMDB id the crosswalk disputes or a movie whose IMDb disagrees', async () => {
    const f = fixture([series, movie]);
    f.reconciler.creationIdentities.mockResolvedValue([
      { provider: P.TMDB, providerEntityKind: K.SERIES, value: '77' },
    ]);
    f.tmdb.getMovieRoutingProfile.mockResolvedValue({ tmdbId: 1, title: 'M', imdbId: 'tt999' });
    const out = await f.service.collect('US', 'netflix', { watchforge: true });
    expect(out.items.map((i) => i.errorMessage)).toEqual([
      'conflict:tmdb_mismatch',
      'conflict:imdb_mismatch',
    ]);
    expect(out.conflicts).toBe(2);
  });

  it('retries without WatchForge when only WatchForge disagrees; an outage stays unresolved', async () => {
    const f = fixture([series, series]);
    f.reconciler.creationIdentities
      .mockRejectedValueOnce(new ConflictException('imdb_disagreement'))
      .mockResolvedValueOnce([{ provider: P.TMDB, providerEntityKind: K.SERIES, value: '10' }])
      .mockRejectedValueOnce(new Error('tvdb timeout'));
    const out = await f.service.collect('US', 'netflix', { watchforge: true });
    expect(out.items.map((i) => i.status)).toEqual(['pending', 'skipped']);
    expect(out.items[1].errorMessage).toBe('unresolved:tvdb timeout');
    expect(f.reconciler.creationIdentities.mock.calls[1][2]).toEqual({
      verifyTvdbLink: true,
      watchforgeLane: null,
    });
  });

  it('keeps only subscription titles for Prime Video and Apple TV', async () => {
    const rental = { ...movie, tmdbId: 2, imdbId: 'tt2', optionTypes: ['rent', 'buy'] };
    const f = fixture([rental, movie]);
    const out = await f.service.collect('US', 'prime', { watchforge: true });
    expect(out.filtered).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ rank: 1, tmdbId: 1 });
    const n = fixture([rental]);
    expect((await n.service.collect('US', 'netflix', { watchforge: true })).filtered).toBe(0);
  });
});

describe('StreamingChartsService.isAvailable', () => {
  it('requires a configured key and a fresh completed chart', async () => {
    const f = fixture();
    await expect(f.service.isAvailable()).resolves.toBe(true);
    const g = fixture();
    g.prisma.hydrationJob.count.mockResolvedValue(0);
    await expect(g.service.isAvailable()).resolves.toBe(false);
    const h = fixture();
    h.motn.configured.mockResolvedValue(false);
    await expect(h.service.isAvailable()).resolves.toBe(false);
  });

  it('builds rail keys per service and upper-case country', () => {
    expect(streamingTopRailKey('netflix', 'us')).toBe('motn:netflix:US');
  });
});
