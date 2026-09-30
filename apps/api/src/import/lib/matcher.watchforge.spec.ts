import { ImportMatcher } from './matcher';
const uuid = 'f0b746d7-4b91-4b03-aeef-22949555bc27';
function make() {
  const matcher: any = Object.create(ImportMatcher.prototype);
  const verified = {
    status: 'verified',
    title: 'Arrival',
    year: 2016,
    evidence: { title: 'Arrival' },
    externals: [{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '329865' }],
  };
  matcher.identities = { resolveProviderIdentity: jest.fn().mockResolvedValue(verified) };
  matcher.checkIdentityMatch = jest.fn(async (m: any) => m);
  matcher.matchByExternalIds = jest
    .fn()
    .mockResolvedValue({ mediaId: 'arrival', confidence: 0.95, matchedTitle: 'Arrival' });
  matcher.tmdb = { getAlternativeTitles: jest.fn().mockResolvedValue(['Premier contact']) };
  const tx: any = {
    $queryRaw: jest.fn(),
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({
        type: 'MOVIE',
        externalIds: [{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '329865' }],
        show: null,
        canonicalSource: null,
      }),
    },
    externalId: {
      findFirst: jest.fn().mockResolvedValue({ mediaId: 'arrival' }),
      upsert: jest.fn().mockResolvedValue({ mediaId: 'arrival' }),
    },
  };
  matcher.prisma = {
    externalId: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  return { matcher, tx, verified };
}
describe('WatchForge movie UUID staging', () => {
  it('serves prefetched episodes without querying canonical ownership for every row', async () => {
    const canonical = { resolveMediaId: jest.fn() },
      prisma = {};
    const matcher = new ImportMatcher(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      undefined,
      canonical as any,
    );
    (matcher as any).episodeCache.set('ext-ep:show:THE_TVDB:123', 'episode');
    (matcher as any).episodeCache.set('show:1:2:s', 'episode');
    for (let i = 0; i < 1000; i++) {
      expect(await matcher.resolveEpisodeByExternalIds('show', { tvdb: 123 })).toBe('episode');
      expect(await matcher.resolveEpisode('show', 1, 2)).toBe('episode');
    }
    expect(canonical.resolveMediaId).not.toHaveBeenCalled();
  });

  it('binds a verified localized title through the existing external-id table', async () => {
    const { matcher, tx } = make();
    expect(await matcher.matchMovieUuid(uuid, 'Premier contact', 2016)).toMatchObject({
      mediaId: 'arrival',
      confidence: 0.95,
    });
    expect(tx.externalId.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          provider: 'TV_TIME',
          providerEntityKind: 'MOVIE',
          value: uuid,
          mediaId: 'arrival',
        },
        update: {},
      }),
    );
  });
  it('keeps UUID-only evidence reviewable instead of accepting it as independently corroborated', async () => {
    const { matcher, tx } = make();
    expect(await matcher.matchMovieUuid(uuid, '')).toMatchObject({
      mediaId: 'arrival',
      confidence: 0.6,
      matchedTitle: 'Arrival',
    });
    expect(tx.externalId.upsert).not.toHaveBeenCalled();
  });
  it('does not bind a contradicted release year', async () => {
    const { matcher, tx } = make();
    expect(await matcher.matchMovieUuid(uuid, 'Arrival', 1996)).toMatchObject({ confidence: 0.6 });
    expect(tx.externalId.upsert).not.toHaveBeenCalled();
  });
  it.each([{ status: 'conflict', reason: 'imdb_disagreement' }])(
    'prevents unsafe title fallback for %s',
    async (result) => {
      const { matcher } = make();
      matcher.identities.resolveProviderIdentity.mockResolvedValue(result);
      expect(await matcher.matchMovieUuid(uuid, 'Arrival')).toMatchObject({ mediaId: null });
      expect(matcher.matchByExternalIds).not.toHaveBeenCalled();
    },
  );
  it('does not call WatchForge while checking an existing UUID binding', async () => {
    const { matcher } = make();
    expect(await matcher.matchMovieUuid(uuid, 'Arrival', 2016, null, true)).toBeNull();
    expect(matcher.identities.resolveProviderIdentity).not.toHaveBeenCalled();
  });
  it.each(['quota', 'unavailable', 'disabled'])(
    'does not suppress normal matching during %s',
    async (reason) => {
      const { matcher } = make();
      matcher.identities.resolveProviderIdentity.mockResolvedValue({ status: 'deferred', reason });
      expect(await matcher.matchMovieUuid(uuid, 'Arrival')).toBeNull();
    },
  );
  it('allows the ordinary matcher when WatchForge has no mapping', async () => {
    const { matcher } = make();
    matcher.identities.resolveProviderIdentity.mockResolvedValue({ status: 'unmapped' });
    expect(await matcher.matchMovieUuid(uuid, 'Arrival')).toBeNull();
  });
  it('rejects a competing UUID owner without moving its alias', async () => {
    const { matcher, tx } = make();
    tx.externalId.upsert.mockResolvedValue({ mediaId: 'other' });
    expect(await matcher.matchMovieUuid(uuid, 'Arrival', 2016)).toMatchObject({ mediaId: null });
    expect(tx.externalId.upsert.mock.calls[0][0].update).toEqual({});
  });
  it('uses an accepted binding without another provider lookup', async () => {
    const { matcher } = make();
    matcher.prisma.externalId.findFirst.mockResolvedValue({
      mediaId: 'arrival',
      media: { type: 'MOVIE', title: 'Arrival', movie: { releaseYear: 2016 } },
    });
    expect(await matcher.matchMovieUuid(uuid, 'Arrival', 2016)).toMatchObject({
      mediaId: 'arrival',
    });
    expect(matcher.identities.resolveProviderIdentity).not.toHaveBeenCalled();
  });
});
