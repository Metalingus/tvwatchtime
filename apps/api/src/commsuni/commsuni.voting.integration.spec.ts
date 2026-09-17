import { MediaVotesService } from '../common/media-votes.service';
import { ShowsService } from '../shows/shows.service';
import { CommsUniVotingService } from './commsuni.voting.service';

function fixture() {
  let current = 3;
  const reactions = new Set<string>();
  const prisma: any = {
    commsUniVoteReceipt: { findMany: jest.fn().mockResolvedValue([]) },
    commsUniOutbox: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: { findFirst: jest.fn(async ({ where }) => ({ id: where.id, type: where.type })) },
    userMovieStatus: { findUnique: jest.fn().mockResolvedValue({ watched: true }) },
    userEpisodeStatus: { findUnique: jest.fn().mockResolvedValue({ watched: true }) },
    rating: {
      findUnique: jest.fn(async () => ({ rating: current })),
      findFirst: jest.fn(async () => ({ rating: current })),
      groupBy: jest.fn(async () => [{ rating: current, _count: { _all: 1 } }]),
      upsert: jest.fn(async ({ update }) => {
        current = update.rating;
        return { rating: current };
      }),
    },
    reaction: {
      upsert: jest.fn(async ({ create }) => {
        reactions.add(create.reaction);
        return create;
      }),
      deleteMany: jest.fn(async ({ where }) => {
        reactions.delete(where.reaction);
        return { count: 1 };
      }),
      findMany: jest.fn(async () => [...reactions].map((reaction) => ({ reaction }))),
      findUnique: jest.fn(async ({ where }) => {
        const reaction = (where.userId_episodeId_reaction ?? where.userId_mediaId_reaction)
          .reaction;
        return reactions.has(reaction) ? { id: reaction, reaction } : null;
      }),
      create: jest.fn(async ({ data }) => {
        reactions.add(data.reaction);
        return data;
      }),
      delete: jest.fn(async ({ where }) => {
        reactions.delete(where.id);
      }),
      groupBy: jest.fn(async ({ by }) =>
        by.includes('userId')
          ? reactions.size
            ? [{ userId: 'user', _count: { _all: reactions.size } }]
            : []
          : [...reactions].map((reaction) => ({ reaction, _count: { _all: 1 } })),
      ),
    },
    mediaCast: { count: jest.fn().mockResolvedValue(0) },
    characterVote: {
      findUnique: jest.fn().mockResolvedValue(null),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  };
  const reads: any = {
    engagement: jest.fn().mockResolvedValue({
      available: true,
      entity: { type: 'episode', id: 'entity', reference: 'tvdb-1-s1e1' },
      sections: [
        {
          kind: 'emotion',
          options: ['SHOCKED', 'AMUSED', 'THRILLED'].map((value, index) => ({
            key: 'emotion:' + index,
            localValue: value,
            count: 1,
            selected: false,
            label: value,
            imageUrl: null,
          })),
        },
        {
          kind: 'star_rating',
          options: [
            {
              key: 'rating:28',
              localValue: '3',
              count: 50,
              selected: false,
              imageUrl: null,
              label: 'Good',
            },
            {
              key: 'rating:29',
              localValue: '4',
              count: 10,
              selected: false,
              imageUrl: null,
              label: 'Great',
            },
          ],
        },
      ],
    }),
  };
  const adapter = new CommsUniVotingService(
    {
      enabled: true,
      writesEnabled: false,
      scope: 'scope',
      voteScope: 'scope',
      actor: (id: string) => id,
    } as any,
    reads,
    prisma,
  );
  return { prisma, reads, adapter };
}
it('returns shared counts and local selection through the existing movie detail and voting methods', async () => {
  const f = fixture();
  const service = new MediaVotesService(f.prisma, { emit: jest.fn() } as any, undefined, f.adapter);
  const detail = await service.getMovieInteractions('movie', 'user');
  expect(detail.rating).toMatchObject({ userVote: '3', total: 61, aggregateSource: 'commsuni' });
  const updated = await service.voteMovieRating('user', 'movie', 4);
  expect(updated).toMatchObject({ userVote: '4', total: 61, aggregateSource: 'commsuni' });
  expect(detail.rating.options.find((o) => o.value === '3')?.count).toBe(51);
  expect(updated.options.find((o) => o.value === '3')?.count).toBe(50);
  expect(updated.options.find((o) => o.value === '4')?.count).toBe(11);
  expect(f.prisma.rating.upsert).toHaveBeenCalled();
  expect(f.reads.engagement).toHaveBeenLastCalledWith('user', 'MOVIE', 'movie', false);
});
it('returns shared counts through the existing episode vote endpoint logic', async () => {
  const f = fixture();
  const service = new ShowsService(
    f.prisma,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.adapter,
  );
  const updated = await service.voteRating('user', 'episode', 4);
  expect(updated).toMatchObject({ userVote: '4', total: 61, aggregateSource: 'commsuni' });
  expect(f.reads.engagement).toHaveBeenCalledWith('user', 'EPISODE', 'episode', false);
});
it('keeps the existing show rating control on the five-star poll', async () => {
  const f = fixture();
  const service = new MediaVotesService(f.prisma, { emit: jest.fn() } as any, undefined, f.adapter);
  const updated = await service.voteShowRating('user', 'show', 4);
  expect(updated).toMatchObject({ userVote: '4', total: 61, aggregateSource: 'commsuni' });
  expect(f.reads.engagement).toHaveBeenCalledWith('user', 'SHOW', 'show', false);
});

it.each(['EPISODE', 'MOVIE'] as const)(
  'keeps %s reaction updates through server reconciliation and removal',
  async (type) => {
    const f = fixture();
    const service =
      type === 'MOVIE'
        ? new MediaVotesService(f.prisma, { emit: jest.fn() } as any, undefined, f.adapter)
        : new ShowsService(
            f.prisma,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            f.adapter,
          );
    const vote = (value: string) =>
      service instanceof ShowsService
        ? service.voteReaction('user', 'episode', value)
        : service.voteMovieReaction('user', 'movie', value);
    const first = await vote('AMUSED');
    expect(first).toMatchObject({ total: 4, userVotes: ['AMUSED'], countedUserVotes: ['AMUSED'] });
    expect(first.options.find((o) => o.value === 'AMUSED')?.count).toBe(2);
    const second = await vote('SHOCKED');
    expect(second.total).toBe(5);
    expect(second.options.find((o) => o.value === 'SHOCKED')?.count).toBe(2);
    const removed = await vote('AMUSED');
    expect(removed).toMatchObject({
      total: 4,
      userVotes: ['SHOCKED'],
      countedUserVotes: ['SHOCKED'],
    });
    expect(removed.options.find((o) => o.value === 'AMUSED')?.count).toBe(1);
    if (service instanceof MediaVotesService) {
      expect((await service.getMovieInteractions('movie', 'user')).reaction).toEqual(removed);
    }
  },
);

function configureCast(f: ReturnType<typeof fixture>) {
  let selected: string | null = 'credit-a';
  f.prisma.mediaCast.count.mockResolvedValue(2);
  f.prisma.mediaCast.findFirst = jest.fn(async ({ where }) =>
    ['credit-a', 'credit-b'].includes(where.id) ? { id: where.id } : null,
  );
  f.prisma.episode = {
    findUnique: jest.fn().mockResolvedValue({ season: { show: { mediaId: 'movie' } } }),
  };
  f.prisma.characterVote.findUnique.mockImplementation(async () =>
    selected ? { castId: selected, source: 'MANUAL' } : null,
  );
  f.prisma.characterVote.findFirst = jest.fn(async () => (selected ? { castId: selected } : null));
  f.prisma.characterVote.groupBy.mockImplementation(async ({ where }: any) => {
    const counts = new Map<string, number>([['credit-a', 1]]);
    if (selected) counts.set(selected, (counts.get(selected) ?? 0) + 1);
    // Imported rows belong to the frozen baseline, not the manual additions.
    if (!where.source) counts.set('credit-b', (counts.get('credit-b') ?? 0) + 1);
    return [...counts].map(([castId, count]) => ({ castId, _count: { _all: count } }));
  });
  f.prisma.characterVote.upsert = jest.fn(async ({ update }) => {
    selected = update.castId;
    return { castId: selected };
  });
  f.prisma.characterVote.deleteMany = jest.fn(async () => {
    selected = null;
  });
  const oldRead = f.reads.engagement.getMockImplementation();
  f.reads.engagement.mockImplementation(async (...args: any[]) => {
    const data = await oldRead(...args);
    return {
      ...data,
      sections: [
        ...data.sections,
        {
          kind: 'cast_vote',
          options: [
            {
              key: 'actor:11',
              localValue: 'credit-a',
              label: 'A',
              count: 2,
              archivedCount: 2,
              nativeCount: 0,
              selected: false,
              imageUrl: null,
            },
            {
              key: 'actor:22',
              localValue: 'credit-b',
              label: 'B',
              count: 1,
              archivedCount: 1,
              nativeCount: 0,
              selected: false,
              imageUrl: null,
            },
          ],
        },
      ],
    };
  });
}

it.each(['EPISODE', 'MOVIE'] as const)(
  'reconciles %s character changes and removal with all local manual voters',
  async (type) => {
    const f = fixture();
    configureCast(f);
    const service =
      type === 'EPISODE'
        ? new ShowsService(
            f.prisma,
            undefined as any,
            undefined as any,
            undefined as any,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            f.adapter,
          )
        : new MediaVotesService(f.prisma, { emit: jest.fn() } as any, undefined, f.adapter);
    const vote = (value: string | null) =>
      service instanceof ShowsService
        ? service.voteFavoriteCharacter('user', 'episode', value)
        : service.voteMovieCharacter('user', 'movie', value);
    const result = await vote('credit-b');
    expect(result).toMatchObject({
      total: 5,
      userVote: 'credit-b',
      countedUserVote: 'credit-b',
      aggregateSource: 'commsuni',
    });
    expect(result?.options).toEqual(
      expect.arrayContaining([
        { castId: 'credit-a', count: 3 },
        { castId: 'credit-b', count: 2 },
      ]),
    );
    const cleared = await vote(null);
    expect(cleared).toMatchObject({ total: 4, userVote: null, countedUserVote: null });
    expect(cleared?.options.find((o) => o.castId === 'credit-b')?.count).toBe(1);
    if (service instanceof MediaVotesService) {
      expect((await service.getMovieInteractions('movie', 'user')).character).toEqual(cleared);
    }
    await expect(vote('foreign-credit')).rejects.toThrow('Character is not part of this');
  },
);

it('returns combined device totals after an episode device change', async () => {
  const f = fixture();
  let selected = 'TV';
  f.prisma.userEpisodeStatus.findUnique.mockImplementation(async () => ({
    watched: true,
    device: selected,
  }));
  f.prisma.userEpisodeStatus.findFirst = jest.fn(async () => ({ device: selected }));
  f.prisma.userEpisodeStatus.updateMany = jest.fn(async ({ data }) => {
    selected = data.device;
    return { device: selected };
  });
  f.prisma.userEpisodeStatus.groupBy = jest.fn(async () => {
    const counts = new Map([['PHONE', 1]]);
    counts.set(selected, (counts.get(selected) ?? 0) + 1);
    return [...counts].map(([device, count]) => ({ device, _count: { _all: count } }));
  });
  const prior = f.reads.engagement.getMockImplementation();
  f.reads.engagement.mockImplementation(async (...args: any[]) => {
    const data = await prior(...args);
    return {
      ...data,
      sections: [
        ...data.sections,
        {
          kind: 'watch_device',
          options: [
            {
              key: 'source:1',
              localValue: 'PHONE',
              label: 'Phone',
              count: 1,
              archivedCount: 1,
              nativeCount: 0,
              selected: false,
              imageUrl: null,
            },
            {
              key: 'source:4',
              localValue: 'TV',
              label: 'TV',
              count: 2,
              archivedCount: 2,
              nativeCount: 0,
              selected: false,
              imageUrl: null,
            },
          ],
        },
      ],
    };
  });
  const service = new ShowsService(
    f.prisma,
    undefined as any,
    undefined as any,
    undefined as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    f.adapter,
  );
  const result = await service.voteDevice('user', 'episode', 'PHONE');
  expect(result).toMatchObject({
    total: 5,
    userVote: 'PHONE',
    countedUserVote: 'PHONE',
    aggregateSource: 'commsuni',
  });
  expect(result.options.find((o) => o.value === 'PHONE')?.count).toBe(3);
  expect(result.options.find((o) => o.value === 'TV')?.count).toBe(2);
});
