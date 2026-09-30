import {
  SimklOutboundService,
  buildSimklIds,
  desiredSimklStatus,
  simklRatingFromStars,
} from './simkl-outbound.service';

const localState = (overrides: Record<string, unknown> = {}) =>
  ({
    mediaId: 'media-1',
    mediaType: 'SHOW',
    title: 'Example',
    year: 2024,
    externalIds: [],
    watchedMovie: false,
    watchedAt: null,
    watchedEpisodes: [],
    inWatchlist: false,
    dropped: false,
    paused: false,
    watchedCount: 0,
    totalCount: 10,
    rating: null,
    ratingSource: null,
    ...overrides,
  }) as any;

describe('SIMKL outbound mapping', () => {
  it('reschedules only affected connected outboxes after a committed identity repair', async () => {
    const prisma = {
      simklSyncItemState: {
        findMany: jest.fn().mockResolvedValue([
          { integrationId: 'first', mediaId: 'movie' },
          { integrationId: 'second', mediaId: 'show' },
        ]),
      },
    };
    const service = new SimklOutboundService(prisma as any, {} as any, {} as any, {} as any);
    const dirty = jest.spyOn(service as any, 'markDirty').mockResolvedValue(undefined);
    await service.onIdentityRepaired({
      repaired: true,
      mediaIds: ['movie', 'show'],
      followUps: [{}],
    });
    expect(prisma.simklSyncItemState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          integration: {
            connectedAt: { not: null },
            outboundEnabled: true,
            paused: false,
            itemsDisabled: false,
          },
        }),
      }),
    );
    expect(dirty.mock.calls).toEqual([
      ['first', ['movie']],
      ['second', ['show']],
    ]);
    prisma.simklSyncItemState.findMany.mockClear();
    await service.onIdentityRepaired({ repaired: false, mediaIds: ['movie'], followUps: [] });
    await service.onIdentityRepaired({ repaired: true, mediaIds: ['movie'], followUps: [] });
    expect(prisma.simklSyncItemState.findMany).not.toHaveBeenCalled();
  });

  it('recovers a missing alternate ID after SIMKL reports not-found and retries only once', async () => {
    const identities = {
      resolveMissingIds: jest
        .fn()
        .mockResolvedValue([{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '10' }]),
    };
    const service = new SimklOutboundService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      identities as any,
    );
    const sent: any[] = [];
    (service as any).sendBatches = jest.fn(async (entries: any[]) => {
      if (!entries.length) return new Set();
      sent.push(entries[0].item.ids);
      return entries[0].item.ids.tmdb ? new Set() : new Set(['media-1']);
    });
    const row = { mediaId: 'media-1', remoteState: null, managedState: null };
    const local = localState({
      mediaType: 'MOVIE',
      watchedMovie: true,
      externalIds: [{ provider: 'THE_TVDB', providerEntityKind: 'MOVIE', value: '900' }],
    });
    const result = await (service as any).processRows(
      'fixture-token',
      [row],
      new Map([['media-1', local]]),
      true,
    );
    expect(result.synced).toEqual([row]);
    expect(result.unmatched).toEqual([]);
    expect(identities.resolveMissingIds).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ tvdb: '900' }, { tvdb: '900', tmdb: '10' }]);
  });

  it('sends every supported correctly-namespaced ID and omits unsafe aliases', () => {
    expect(
      buildSimklIds(
        'SHOW',
        [
          { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt0944947' },
          { provider: 'TMDB', providerEntityKind: 'SERIES', value: '1399' },
          { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '121361' },
          { provider: 'MYANIME_LIST', providerEntityKind: 'ANIME', value: '16498' },
          { provider: 'KITSU', providerEntityKind: 'ANIME', value: '7446' },
          { provider: 'TRAKT', providerEntityKind: 'SERIES', value: 'game-of-thrones' },
          { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '1399' },
        ],
        '17465',
      ),
    ).toEqual({
      imdb: 'tt0944947',
      tmdb: '1399',
      tvdb: '121361',
      mal: '16498',
      kitsu: '7446',
    });
  });

  it('maps five stars to the even SIMKL ten-point values', () => {
    expect([1, 2, 3, 4, 5].map(simklRatingFromStars)).toEqual([2, 4, 6, 8, 10]);
    expect(simklRatingFromStars(0)).toBeNull();
  });

  it('uses deterministic status precedence for shows and movies', () => {
    expect(desiredSimklStatus(localState({ inWatchlist: true }))).toBe('plantowatch');
    expect(desiredSimklStatus(localState({ watchedEpisodes: [{ season: 1, episode: 1 }] }))).toBe(
      'watching',
    );
    expect(desiredSimklStatus(localState({ paused: true, dropped: true }))).toBe('dropped');
    expect(desiredSimklStatus(localState({ watchedCount: 10, totalCount: 10 }))).toBe('completed');
    expect(desiredSimklStatus(localState({ mediaType: 'MOVIE', watchedMovie: true }))).toBe(
      'completed',
    );
  });
});
