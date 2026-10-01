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
    findSeriesByImdb: jest.fn().mockResolvedValue(null),
    getShowEvidence: jest
      .fn()
      .mockResolvedValue({
        tvdbId: 900,
        tmdbId: 10,
        imdbId: 'tt10',
        titles: ['Title'],
        year: 2000,
      }),
    getShowEnglishTitle: jest.fn().mockResolvedValue(null),
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
  it('never spends WatchForge quota while creating media', async () => {
    const f = fixture('MOVIE');
    f.tmdb.findByExternalIdStrict.mockResolvedValue(null);
    const result = await f.service.creationIdentities({
      provider: P.IMDB,
      providerEntityKind: K.MOVIE,
      value: 'tt10',
    });
    expect(result).toEqual([{ provider: P.IMDB, providerEntityKind: K.MOVIE, value: 'tt10' }]);
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('uses WatchForge for an IMDb-only identity only when a budget lane is named', async () => {
    const f = fixture('MOVIE');
    f.tmdb.findByExternalIdStrict.mockResolvedValue(null);
    const result = await f.service.creationIdentities(
      { provider: P.IMDB, providerEntityKind: K.MOVIE, value: 'tt10' },
      undefined,
      { watchforgeLane: 'interactive' },
    );
    expect(result).toEqual(
      expect.arrayContaining([{ provider: P.TMDB, providerEntityKind: K.MOVIE, value: '10' }]),
    );
    expect(f.wf.lookup).toHaveBeenCalledWith(expect.anything(), {
      lane: 'interactive',
      fresh: undefined,
    });
  });
  it('bridges a TVDB-only show to TMDB through TMDB find when both directions agree', async () => {
    const f = fixture();
    f.tvdb.getShowIdentity.mockResolvedValue({ tvdbId: 900, tmdbId: null, imdbId: 'tt10' });
    f.tmdb.getShowRoutingProfile.mockResolvedValue({ tmdbId: 10, tvdbId: 900, imdbId: 'tt10' });
    const result = await f.service.creationIdentities({
      provider: P.THE_TVDB,
      providerEntityKind: K.SERIES,
      value: '900',
    });
    expect(result).toEqual(
      expect.arrayContaining([{ provider: P.TMDB, providerEntityKind: K.SERIES, value: '10' }]),
    );
    expect(f.tmdb.findByExternalIdStrict).toHaveBeenCalledWith('900', 'tvdb_id');
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('does not bridge through TMDB find when TMDB points at a different TVDB series', async () => {
    const f = fixture();
    f.tvdb.getShowIdentity.mockResolvedValue({ tvdbId: 900, tmdbId: null, imdbId: null });
    f.tmdb.getShowRoutingProfile.mockResolvedValue({ tmdbId: 10, tvdbId: 901, imdbId: 'tt10' });
    const result = await f.service.creationIdentities({
      provider: P.THE_TVDB,
      providerEntityKind: K.SERIES,
      value: '900',
    });
    expect(result.some((id) => id.provider === P.TMDB)).toBe(false);
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
  it('re-verifies providers on fresh without re-buying WatchForge evidence', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({ tmdbId: 10, tvdbId: 900, imdbId: 'tt10' });
    await f.service.resolveProviderIdentity(
      { provider: 'tmdb', mediaType: 'tv', id: '10' },
      { fresh: true, lane: 'repair' },
    );
    expect(f.wf.lookup).toHaveBeenCalledWith(expect.anything(), {
      lane: 'repair',
      fresh: undefined,
    });
    expect(f.tmdb.getShowRoutingProfile).toHaveBeenCalledWith(10, { bypassCache: true });
  });
  it('asks for missing ids of existing media in the interactive lane by default', async () => {
    const f = fixture();
    await f.service.resolveMissingIds('media', P.THE_TVDB, { persist: false });
    expect(f.wf.lookup).toHaveBeenCalledWith(expect.anything(), {
      lane: 'interactive',
      fresh: undefined,
    });
  });
  it('rejects contradictory stored claims before any provider request', async () => {
    const f = fixture();
    f.known.push({ provider: P.TMDB, providerEntityKind: K.SERIES, value: '11' });
    await expect(f.service.resolveMissingIds('media', P.THE_TVDB)).rejects.toThrow('Conflicting');
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });
});

describe('retired TVDB ids (deleted and re-created by TVDB)', () => {
  const { ProviderError } = jest.requireActual('../providers/shared/provider-errors');
  function retiredFixture(
    options: { oldIdLive?: boolean; wfIds?: string[]; outage?: boolean } = {},
  ) {
    const f = fixture();
    f.wf.lookup.mockResolvedValue({
      status: 'found',
      identity: {
        wfId: '14104',
        mediaType: 'tv',
        title: 'Blood of Zeus',
        year: null,
        ids: {
          tmdb: ['111111'],
          tvdb: options.wfIds ?? ['361140', '473467'],
          imdb: ['tt10009170'],
          tvtime_uuid: [],
        },
        primary: { tmdb: '111111', tvdb: '361140', imdb: 'tt10009170', tvtime_uuid: null },
      },
    });
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 111111,
      title: 'Blood of Zeus',
      yearStart: 2020,
      imdbId: 'tt10009170',
      tvdbId: 473467,
    });
    f.tvdb.getShowIdentity.mockImplementation(async (id: number) => {
      if (id === 361140) {
        if (options.outage) throw new ProviderError('upstream', 'tvdb 503', 503);
        if (!options.oldIdLive) throw new ProviderError('not_found', 'tvdb 404', 404);
      }
      return { tvdbId: id, tmdbId: 111111, imdbId: 'tt10009170' };
    });
    return f;
  }
  const query = { provider: 'tvdb' as const, mediaType: 'tv' as const, id: '361140' };

  it('verifies the work through its live TVDB id and never proposes the retired id', async () => {
    const f = retiredFixture();
    const result: any = await f.service.resolveProviderIdentity(query, { lane: 'interactive' });
    expect(result).toMatchObject({ status: 'verified', anchorVerified: true, retiredAnchor: true });
    expect(result.externals).toEqual(
      expect.arrayContaining([
        { provider: P.TMDB, providerEntityKind: K.SERIES, value: '111111' },
        { provider: P.THE_TVDB, providerEntityKind: K.SERIES, value: '473467' },
      ]),
    );
    expect(result.externals.some((id: any) => id.value === '361140')).toBe(false);
  });

  it('keeps the conflict when TVDB still serves the old id', async () => {
    const f = retiredFixture({ oldIdLive: true });
    await expect(f.service.resolveProviderIdentity(query)).resolves.toEqual({
      status: 'conflict',
      reason: 'tvdb_disagreement',
    });
  });

  it('keeps the conflict when WatchForge does not file both ids under one work', async () => {
    const f = retiredFixture({ wfIds: ['361140'] });
    await expect(f.service.resolveProviderIdentity(query)).resolves.toMatchObject({
      status: 'conflict',
    });
  });

  it('defers instead of guessing when TVDB is unavailable', async () => {
    const f = retiredFixture({ outage: true });
    await expect(f.service.resolveProviderIdentity(query)).resolves.toEqual({
      status: 'deferred',
      reason: 'provider_unavailable',
    });
  });
});

describe('series IMDb crosswalk and TMDB tvdb_id verification', () => {
  const imdb = { provider: P.IMDB, providerEntityKind: K.SERIES, value: 'tt10' };
  const tmdbShow = { provider: P.TMDB, providerEntityKind: K.SERIES, value: '10' };
  const tvdb = (value: string) => ({ provider: P.THE_TVDB, providerEntityKind: K.SERIES, value });

  it('asks TVDB remote-id first and takes TMDB from the verified TVDB record', async () => {
    const f = fixture();
    f.tvdb.findSeriesByImdb.mockResolvedValue({ tvdbId: 900, tmdbId: 10, imdbId: 'tt10' });
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 900,
    });
    const result = await f.service.creationIdentities(imdb, P.THE_TVDB, { verifyTvdbLink: true });
    expect(result).toEqual(expect.arrayContaining([imdb, tmdbShow, tvdb('900')]));
    expect(f.tvdb.findSeriesByImdb).toHaveBeenCalledWith('tt10');
    expect(f.tmdb.findByExternalIdStrict).not.toHaveBeenCalled();
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });

  it('drops a TMDB tvdb_id whose TVDB record is another title, then stops without a lane', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 555,
    });
    f.tvdb.getShowEvidence.mockResolvedValue({
      tvdbId: 555,
      tmdbId: null,
      imdbId: null,
      titles: ['Unrelated Show'],
      year: 2000,
    });
    const result = await f.service.creationIdentities(imdb, P.THE_TVDB, { verifyTvdbLink: true });
    expect(result).toEqual(expect.arrayContaining([imdb, tmdbShow]));
    expect(result.some((id) => id.provider === P.THE_TVDB)).toBe(false);
    expect(f.tvdb.getShowEnglishTitle).toHaveBeenCalledWith(555);
    expect(f.wf.lookup).not.toHaveBeenCalled();
  });

  it('falls back to WatchForge for a refuted link when a lane is given', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 555,
    });
    f.tvdb.getShowEvidence.mockResolvedValue({
      tvdbId: 555,
      tmdbId: 77,
      imdbId: null,
      titles: ['Title'],
      year: 2000,
    });
    const result = await f.service.creationIdentities(imdb, P.THE_TVDB, {
      verifyTvdbLink: true,
      watchforgeLane: 'repair',
    });
    // WatchForge's TVDB id is corroborated by TVDB's own record, not by the refuted TMDB link.
    expect(result).toEqual(expect.arrayContaining([imdb, tmdbShow, tvdb('900')]));
    expect(result.some((id) => id.value === '555')).toBe(false);
    expect(f.wf.lookup).toHaveBeenCalledWith(
      { provider: 'imdb', mediaType: 'tv', id: 'tt10' },
      expect.objectContaining({ lane: 'repair' }),
    );
  });

  it('accepts a TMDB tvdb_id by title and year, and keeps it when TVDB is down', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'The Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 555,
    });
    f.tvdb.getShowEvidence.mockResolvedValue({
      tvdbId: 555,
      tmdbId: null,
      imdbId: null,
      titles: ['the title'],
      year: 2001,
    });
    expect(
      await f.service.creationIdentities(tmdbShow, undefined, { verifyTvdbLink: true }),
    ).toEqual(expect.arrayContaining([tvdb('555')]));
    f.tvdb.getShowEvidence.mockRejectedValue(new Error('timeout'));
    expect(
      await f.service.creationIdentities(tmdbShow, undefined, { verifyTvdbLink: true }),
    ).toEqual(expect.arrayContaining([tvdb('555')]));
  });

  it('refuses a TMDB tvdb_id more than a year off', async () => {
    const f = fixture();
    f.tvdb.getShowEvidence.mockResolvedValue({
      tvdbId: 555,
      tmdbId: null,
      imdbId: null,
      titles: ['Title'],
      year: 1985,
    });
    await expect(
      f.service.verifyTmdbTvdbLink(
        { tmdbId: 10, title: 'Title', yearStart: 2000, imdbId: null },
        555,
      ),
    ).resolves.toBe('mismatch');
  });

  it('treats a verified TMDB link that names another TVDB series as a conflict', async () => {
    const f = fixture();
    f.tvdb.findSeriesByImdb.mockResolvedValue({ tvdbId: 900, tmdbId: null, imdbId: 'tt10' });
    f.tvdb.getShowIdentity.mockResolvedValue({ tvdbId: 900, tmdbId: null, imdbId: 'tt10' });
    f.tmdb.findByExternalIdStrict.mockResolvedValue({ show: null, movie: null });
    // TVDB had no TMDB link: TMDB /find by IMDb then supplies a different, verified TVDB id.
    f.tmdb.findByExternalIdStrict
      .mockResolvedValueOnce({ show: null, movie: null })
      .mockResolvedValueOnce({ show: { tmdbId: 10 }, movie: null });
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 555,
    });
    f.tvdb.getShowEvidence.mockResolvedValue({
      tvdbId: 555,
      tmdbId: 10,
      imdbId: 'tt10',
      titles: ['Title'],
      year: 2000,
    });
    await expect(
      f.service.creationIdentities(imdb, P.THE_TVDB, { verifyTvdbLink: true }),
    ).rejects.toThrow('Provider identities disagree');
  });

  it('leaves default TMDB stub creation unverified and TVDB-free', async () => {
    const f = fixture();
    f.tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 10,
      title: 'Title',
      yearStart: 2000,
      imdbId: 'tt10',
      tvdbId: 555,
    });
    expect(await f.service.creationIdentities(tmdbShow)).toEqual(
      expect.arrayContaining([tvdb('555')]),
    );
    expect(f.tvdb.getShowEvidence).not.toHaveBeenCalled();
    expect(f.tvdb.findSeriesByImdb).not.toHaveBeenCalled();
  });
});
