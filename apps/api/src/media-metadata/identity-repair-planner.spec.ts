jest.mock('./identity-transfer-manifest', () => ({
  IdentityTransferManifest: jest
    .fn()
    .mockImplementation(() => ({ summary: async () => ({ blocked: false }) })),
}));
import { IdentityRepairService } from './identity-repair.service';

const tmdb = { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '1' };
const tvdb = { provider: 'THE_TVDB', providerEntityKind: 'MOVIE', value: '2' };
function make(duplicate = false, manual = false) {
  const state = {
    id: 'tmdb-owner',
    type: manual ? 'SHOW' : 'MOVIE',
    title: 'Movie',
    movie: manual ? null : { releaseYear: 2000 },
    show: manual ? { yearStart: 2000 } : null,
    metadataProvenance: {},
    externalIds: [{ id: 'tvdb', ...tvdb }, ...(duplicate ? [] : [{ id: 'tmdb', ...tmdb }])],
  };
  if (manual)
    state.externalIds.forEach((id) => {
      id.providerEntityKind = 'SERIES';
    });
  const root = {
    status: 'verified',
    anchorVerified: true,
    evidence: { wfId: 'wf', title: 'Movie', ids: { tvdb: [] } },
    title: 'Movie',
    year: 2000,
    externals: [tmdb, tvdb],
    wrongTypeOwnerIds: [],
    ownerMediaIds: duplicate ? ['tvdb-owner', 'tmdb-owner'] : ['tmdb-owner'],
  };
  const resolver = {
    resolveProviderIdentity: jest.fn(async (query: any) => ({
      ...root,
      externals: query.provider === 'tmdb' ? [tmdb] : [tmdb, tvdb],
    })),
  };
  const zero = { count: jest.fn().mockResolvedValue(0) };
  const prisma = {
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    mediaItem: {
      findUniqueOrThrow: jest.fn().mockResolvedValue(state),
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'tvdb-owner',
          title: 'Movie',
          contentClassification: 'ANIME',
          show: null,
          externalIds: [tvdb],
        },
        {
          id: 'tmdb-owner',
          title: 'Movie',
          contentClassification: 'ANIME',
          show: manual ? { structureReason: 'MANUAL_OVERRIDE', structureProvider: 'TMDB' } : null,
          externalIds: [tmdb],
        },
      ]),
    },
    userShowStatus: zero,
    userMovieStatus: zero,
    watchHistory: zero,
    rating: zero,
    characterVote: zero,
    favorite: zero,
    customListItem: zero,
  };
  const canonical = {
    identityFamily: jest
      .fn()
      .mockResolvedValue({ status: 'ready', reason: 'verified-family', fingerprint: 'graph' }),
  };
  const providers = {
    getMovie: jest.fn().mockResolvedValue({ title: 'Movie', cast: [] }),
    getShow: jest.fn().mockResolvedValue({ title: 'Movie', cast: [], seasons: [] }),
  };
  const tvdbProvider = {
    getMovie: jest.fn(),
    getShow: jest.fn().mockResolvedValue({ seasons: [] }),
  };
  const service = new IdentityRepairService(
    prisma as any,
    { set: jest.fn() } as any,
    resolver as any,
    canonical as any,
    {} as any,
    providers as any,
    tvdbProvider as any,
  );
  return { service, resolver, canonical, providers, tvdbProvider, root, state };
}

describe('WatchForge movie repair planning', () => {
  it.each([2000, null])(
    'partitions multiple movie IDs only when stored year and independent anchors prove the retained work (%s)',
    async (year) => {
      const { service, resolver, state, root } = make();
      state.movie!.releaseYear = year as any;
      state.externalIds.push({ id: 'wrong-tmdb', ...tmdb, value: '999' });
      resolver.resolveProviderIdentity.mockImplementation(async (query: any) =>
        query.id === '999'
          ? {
              ...root,
              title: 'Other Movie',
              year: 2016,
              evidence: { ...root.evidence, wfId: 'other' },
              externals: [{ ...tmdb, value: '999' }],
            }
          : root,
      );
      const result = await service.preview({ mediaId: 'tmdb-owner' }, 'automatic');
      expect(result.status).toBe(year ? 'ready' : 'blocked');
      if (year) {
        expect(result.action).toBe('partition');
        expect(result.removeAliasIds).toEqual(['wrong-tmdb']);
      } else expect(result.reason).toBe('choose-current-identity-before-partition');
    },
  );

  it('preserves an explicit TMDB structure override on an anime duplicate family', async () => {
    const { service, resolver, root, canonical } = make(true, true);
    resolver.resolveProviderIdentity.mockResolvedValue({
      ...root,
      externals: root.externals.map((id) => ({ ...id, providerEntityKind: 'SERIES' })),
    });
    const result = await service.preview({ mediaId: 'tmdb-owner' }, 'admin');
    expect(result).toMatchObject({
      status: 'ready',
      action: 'consolidate',
      targetMediaId: 'tmdb-owner',
    });
    expect(canonical.identityFamily).toHaveBeenCalledWith(
      expect.any(Array),
      'tmdb-owner',
      expect.objectContaining({ canonical: 'tmdb' }),
    );
  });

  it('unions compatible corroborated IDs instead of discarding TVDB on the last primary lookup', async () => {
    const { service } = make();
    const result = await service.preview({ mediaId: 'tmdb-owner' }, 'admin');
    expect(result).toMatchObject({ status: 'ready', action: 'refresh' });
    expect(result.verifiedIds).toEqual(expect.arrayContaining([tmdb, tvdb]));
  });
  it('keeps anime movies on the TMDB owner and uses the TMDB movie snapshot', async () => {
    const { service, canonical, providers, tvdbProvider } = make(true);
    const result = await service.preview({ mediaId: 'tmdb-owner' }, 'admin');
    expect(result).toMatchObject({
      status: 'ready',
      action: 'consolidate',
      targetMediaId: 'tmdb-owner',
    });
    expect(canonical.identityFamily).toHaveBeenCalledWith(
      expect.any(Array),
      'tmdb-owner',
      expect.objectContaining({ canonical: 'tmdb' }),
    );
    expect(providers.getMovie).toHaveBeenCalledWith(1, 'en-US', { bypassCache: true });
    expect(tvdbProvider.getMovie).not.toHaveBeenCalled();
  });
  it('blocks incompatible primary IDs even when the catalog assigns them the same WFDB family', async () => {
    const { service, resolver, root } = make();
    resolver.resolveProviderIdentity
      .mockResolvedValueOnce(root)
      .mockResolvedValueOnce({ ...root, externals: [{ ...tmdb, value: '999' }] });
    expect(await service.preview({ mediaId: 'tmdb-owner' }, 'admin')).toMatchObject({
      status: 'blocked',
      reason: 'inconsistent-verified-primary-ids',
      token: null,
    });
  });
});
