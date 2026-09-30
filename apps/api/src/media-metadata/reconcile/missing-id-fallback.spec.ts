import { MediaReconciler } from './media-reconciler.service';
import { ExternalProvider as P, ProviderEntityKind as K } from '@tvwatch/shared';

function fixture(type: 'SHOW' | 'MOVIE' = 'SHOW') {
  const kind = type === 'SHOW' ? K.SERIES : K.MOVIE;
  const known = [{ provider: P.TMDB, providerEntityKind: kind, value: '10' }];
  const prisma: any = {
    mediaCanonicalLink: { findUnique: jest.fn().mockResolvedValue(null) },
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 'media', type, externalIds: known }),
    },
    externalId: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const tmdb: any = {
    enabled: true,
    getShowRoutingProfile: jest.fn().mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: null,
    }),
    getMovieRoutingProfile: jest
      .fn()
      .mockResolvedValue({ tmdbId: 10, title: 'Title', releaseYear: 2000, imdbId: 'tt10' }),
    findByExternalIdStrict: jest
      .fn()
      .mockResolvedValue({ show: { tmdbId: 10 }, movie: { tmdbId: 10 } }),
  };
  const tvdb: any = {
    enabled: true,
    getShowIdentity: jest.fn().mockResolvedValue({ tvdbId: 900, tmdbId: 10, imdbId: 'tt10' }),
    getMovieIdentity: jest.fn().mockResolvedValue({ tvdbId: 900, tmdbId: 10, imdbId: 'tt10' }),
    findMovieByImdb: jest.fn().mockResolvedValue(null),
  };
  const wf: any = {
    lookup: jest.fn().mockResolvedValue({
      status: 'found',
      identity: {
        wfId: '100',
        mediaType: type === 'SHOW' ? 'tv' : 'movie',
        title: 'Title',
        year: 2000,
        ids: { tmdb: ['10'], tvdb: ['900'], imdb: ['tt10'], tvtime_uuid: [] },
        primary: { tmdb: '10', tvdb: '900', imdb: 'tt10', tvtime_uuid: null },
      },
    }),
  };
  const service = new MediaReconciler(prisma, {} as any, wf, tmdb, tvdb);
  return { service, prisma, tmdb, tvdb, wf, known, kind };
}
describe('shared missing-provider-ID fallback', () => {
  it('uses a stored requested ID without any provider lookup', async () => {
    const f = fixture();
    expect(await f.service.resolveMissingIds('media', P.TMDB)).toEqual(f.known);
    expect(f.tmdb.getShowRoutingProfile).not.toHaveBeenCalled();
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('uses an existing native show crosswalk without WatchForge', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({ tmdbId: 10, tvdbId: 900, imdbId: 'tt10' });
    expect(await f.service.creationIdentities(f.known[0])).toEqual(
      expect.arrayContaining([
        { provider: P.THE_TVDB, providerEntityKind: K.SERIES, value: '900' },
      ]),
    );
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('resolves missing TVDB show links through WatchForge after the native miss', async () => {
    const f = fixture();
    expect(await f.service.resolveMissingIds('media', P.THE_TVDB, { persist: false })).toEqual(
      expect.arrayContaining([
        { provider: P.THE_TVDB, providerEntityKind: K.SERIES, value: '900' },
      ]),
    );
    expect(f.wf.lookup).toHaveBeenCalledWith(
      { provider: 'tmdb', mediaType: 'tv', id: '10' },
      expect.anything(),
    );
  });
  it('uses a native movie IMDb crosswalk before consulting WatchForge', async () => {
    const f = fixture('MOVIE');
    f.tvdb.findMovieByImdb.mockResolvedValue({ tvdbId: 900, tmdbId: 10, imdbId: 'tt10' });
    expect(await f.service.resolveMissingIds('media', P.THE_TVDB, { persist: false })).toEqual(
      expect.arrayContaining([{ provider: P.THE_TVDB, providerEntityKind: K.MOVIE, value: '900' }]),
    );
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('uses WatchForge for an IMDb-only identity after direct translation fails', async () => {
    const f = fixture('MOVIE');
    f.tmdb.findByExternalIdStrict.mockResolvedValue(null);
    const result = await f.service.creationIdentities({
      provider: P.IMDB,
      providerEntityKind: K.MOVIE,
      value: 'tt10',
    });
    expect(result).toEqual(
      expect.arrayContaining([{ provider: P.TMDB, providerEntityKind: K.MOVIE, value: '10' }]),
    );
    expect(f.wf.lookup).toHaveBeenCalled();
  });
  it('rejects contradictory stored claims before any provider request', async () => {
    const f = fixture();
    f.known.push({ provider: P.TMDB, providerEntityKind: K.SERIES, value: '11' });
    await expect(f.service.resolveMissingIds('media', P.THE_TVDB)).rejects.toThrow('Conflicting');
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
});
