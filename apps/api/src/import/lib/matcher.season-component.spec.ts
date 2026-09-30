jest.mock('../../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
import { ImportMatcher } from './matcher';
function fixture(mismatch = false) {
  const source = [1, 2].map((number) => ({
    tmdbId: 1000 + number,
    number,
    title: 'Distinct story ' + number,
    airDate: '2024-04-03',
    runtimeMinutes: 35,
  }));
  const target = source.map((e) => ({
    ...e,
    tmdbId: e.number,
    title: mismatch && e.number === 2 ? 'Different story' : e.title,
  }));
  const prisma: any = {
    episodeExternalId: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          target.map((e) => ({ value: String(e.tmdbId), episodeId: 'e' + e.number })),
        ),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    mediaCanonicalCopy: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const meta = { ensureShowFull: jest.fn().mockResolvedValue('child-show') };
  const tmdb = {
    enabled: true,
    searchShows: jest.fn().mockResolvedValue({
      items: [{ tmdbId: 10, title: 'Crime Scene Berlin: Nightlife Killer' }],
    }),
    getShow: jest.fn().mockResolvedValue({
      title: 'Crime Scene Berlin: Nightlife Killer',
      seasons: [{ number: 1, isSpecial: false, episodes: target }],
    }),
  };
  const tvdb = {
    enabled: true,
    getEpisode: jest.fn().mockResolvedValue({ seriesId: 50, seasonNumber: 4 }),
    getShow: jest.fn().mockResolvedValue({
      title: 'Crime Scene',
      seasons: [{ number: 4, title: 'Berlin: Nightlife Killer', episodes: source }],
    }),
  };
  const matcher = new ImportMatcher(prisma, meta as any, tmdb as any, tvdb as any);
  return { matcher, prisma, meta };
}
describe('verified anthology season component', () => {
  it('maps a complete provider season and records episode aliases without attaching the aggregate show ID', async () => {
    const { matcher, prisma, meta } = fixture();
    expect(await (matcher as any).recoverTvdbSeasonComponent('1001')).toEqual({
      mediaId: 'child-show',
      episodeId: 'e1',
    });
    expect(meta.ensureShowFull).toHaveBeenCalledWith(10);
    expect(prisma.mediaCanonicalCopy.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.mediaCanonicalCopy.upsert.mock.calls[0][0].create).toMatchObject({
      entityType: 'EPISODE_ALIAS',
      sourceId: 'THE_TVDB:EPISODE:1001',
      targetId: 'e1',
    });
    expect(await matcher.resolveEpisodeByExternalIds('child-show', { tvdb: 1002 })).toBe('e2');
  });
  it('does not hydrate or bind a partial or contradictory season match', async () => {
    const { matcher, prisma, meta } = fixture(true);
    expect(await (matcher as any).recoverTvdbSeasonComponent('1001')).toBeNull();
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(prisma.mediaCanonicalCopy.upsert).not.toHaveBeenCalled();
  });
});
