import { ImportMatcher } from './matcher';
import { ProviderError } from '../../media-metadata/providers/shared/provider-errors';

function fixture() {
  const ids = [
    { provider: 'TMDB', providerEntityKind: 'SERIES', value: '10' },
    { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '20' },
  ];
  const media: any = {
    id: 'show',
    type: 'SHOW',
    title: 'Example',
    show: { structureProvider: 'TMDB' },
    movie: null,
    externalIds: ids,
    metadataProvenance: {
      identityQuarantinedAliases: [
        { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '19' },
      ],
    },
  };
  const prisma: any = {
    mediaItem: { findUnique: jest.fn().mockResolvedValue(media) },
    episodeExternalId: { upsert: jest.fn() },
  };
  const tvdb: any = {
    enabled: true,
    getShowIdentity: jest.fn().mockRejectedValue(new ProviderError('not_found', 'deleted', 404)),
    getEpisode: jest.fn().mockRejectedValue(new ProviderError('not_found', 'deleted', 404)),
    getEpisodeRoutingIndex: jest.fn().mockResolvedValue(
      new Map([
        [201, { seasonNumber: 1, episodeNumber: 1 }],
        [202, { seasonNumber: 1, episodeNumber: 2 }],
      ]),
    ),
  };
  const tmdb: any = {
    enabled: true,
    getShowRoutingProfile: jest.fn().mockResolvedValue({ tvdbId: 20 }),
  };
  const remap: any = {
    resolveTvdbEpisodeAliasesToCanonical: jest.fn().mockResolvedValue({
      mappings: new Map([
        ['201', 'e1'],
        ['202', 'e2'],
      ]),
    }),
  };
  const matcher = new ImportMatcher(prisma, {} as any, tmdb, tvdb, remap);
  const source = { title: 'Example', seriesId: '19', episodeId: '199', season: 1, episode: 2 };
  return { matcher, prisma, tvdb, tmdb, remap, source, media };
}

describe('retired TVDB episode recovery', () => {
  it.each([86, 45])(
    'uses the confirmed Atlantis split only while the current target is still the combined finale (%s minutes)',
    async (runtime) => {
      const f = fixture();
      f.media.title = 'Atlantis';
      f.prisma.importItem = { findFirst: jest.fn().mockResolvedValue({ id: 'first-half' }) };
      f.media.externalIds[1].value = '248596';
      f.tmdb.getShowRoutingProfile.mockResolvedValue({ tvdbId: 248596 });
      f.tvdb.getEpisodeRoutingIndex.mockResolvedValue(
        new Map([
          [5210722, { seasonNumber: 2, episodeNumber: 11 }],
          [5220562, { seasonNumber: 2, episodeNumber: 12 }],
        ]),
      );
      f.tvdb.getEpisode.mockImplementation(async (id: number) => {
        if (id === 7659037) throw new ProviderError('not_found', 'deleted', 404);
        return {
          seriesId: 248596,
          seasonNumber: 2,
          episode: { number: 12, title: 'The Queen Must Die', runtimeMinutes: runtime },
        };
      });
      f.remap.resolveTvdbEpisodeAliasesToCanonical.mockResolvedValue({
        mappings: new Map([
          ['5210722', 'e11'],
          ['5220562', 'finale'],
        ]),
      });
      expect(
        await f.matcher.recoverRetiredTvdbEpisode('show', {
          importId: 'archive',
          seriesId: '248596',
          episodeId: '7659037',
          title: 'Atlantis',
          season: 2,
          episode: 13,
        }),
      ).toBe(runtime === 86 ? 'finale' : null);
      f.prisma.importItem.findFirst.mockResolvedValue(null);
      expect(
        await f.matcher.recoverRetiredTvdbEpisode('show', {
          importId: 'archive',
          seriesId: '248596',
          episodeId: '7659037',
          title: 'Atlantis',
          season: 2,
          episode: 13,
        }),
      ).toBeNull();
      f.prisma.importItem.findFirst.mockClear();
      expect(
        await f.matcher.recoverRetiredTvdbEpisode('show', {
          companionEpisodeIds: new Set(['5220562']),
          seriesId: '248596',
          episodeId: '7659037',
          title: 'Atlantis',
          season: 2,
          episode: 13,
        }),
      ).toBe(runtime === 86 ? 'finale' : null);
      expect(f.prisma.importItem.findFirst).not.toHaveBeenCalled(); // Initial matching has not staged the companion yet.
      expect(f.prisma.episodeExternalId.upsert).not.toHaveBeenCalled();
    },
  );

  it('recovers a deleted ID after parent and full regular season verification without creating a provider alias', async () => {
    const f = fixture();
    expect(await f.matcher.recoverRetiredTvdbEpisode('show', f.source)).toBe('e2');
    expect(f.remap.resolveTvdbEpisodeAliasesToCanonical).toHaveBeenCalledWith('show', [
      '201',
      '202',
    ]);
    expect(f.prisma.episodeExternalId.upsert).not.toHaveBeenCalled();
  });
  it('accepts a current parent ID when the episode ID was deleted', async () => {
    const f = fixture();
    expect(await f.matcher.recoverRetiredTvdbEpisode('show', { ...f.source, seriesId: '20' })).toBe(
      'e2',
    );
    expect(f.tvdb.getShowIdentity).not.toHaveBeenCalled();
  });
  it.each(['live', 'unavailable'])('does not reinterpret a %s episode ID', async (kind) => {
    const f = fixture();
    if (kind === 'live') f.tvdb.getEpisode.mockResolvedValue({ seriesId: 99 });
    else f.tvdb.getEpisode.mockRejectedValue(new ProviderError('upstream', 'outage', 503));
    expect(await f.matcher.recoverRetiredTvdbEpisode('show', f.source)).toBeNull();
    expect(f.remap.resolveTvdbEpisodeAliasesToCanonical).not.toHaveBeenCalled();
  });
  it.each([
    { seriesId: '99' },
    { title: 'Other Show' },
    { season: 0 },
    { episode: 0 },
    { episode: 3 },
  ])('rejects ambiguous or unsupported source coordinates %j', async (change) => {
    const f = fixture();
    expect(
      await f.matcher.recoverRetiredTvdbEpisode('show', { ...f.source, ...change }),
    ).toBeNull();
    expect(f.remap.resolveTvdbEpisodeAliasesToCanonical).not.toHaveBeenCalled();
  });
  it.each([
    new Map([['201', 'e1']]),
    new Map([
      ['201', 'combined'],
      ['202', 'combined'],
    ]),
  ])('rejects partial and combined season bridges', async (mappings) => {
    const f = fixture();
    f.remap.resolveTvdbEpisodeAliasesToCanonical.mockResolvedValue({ mappings });
    expect(await f.matcher.recoverRetiredTvdbEpisode('show', f.source)).toBeNull();
  });
});
