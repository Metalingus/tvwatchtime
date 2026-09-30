// Catalog locking is exercised by the real-database fence suite; these tests isolate service behavior.
jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
function withMockTransaction<T>(prisma: T): T {
  const client = prisma as any;
  if (!client.$transaction)
    client.$transaction = jest.fn(async (work: any) =>
      typeof work === 'function' ? work(client) : Promise.all(work),
    );
  return prisma;
}
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { MediaVotesService } from './media-votes.service';

function setup() {
  const prisma: any = {
    mediaItem: { findFirst: jest.fn(async () => ({ id: 'movie-1' })) },
    userMovieStatus: { findUnique: jest.fn(async () => ({ watched: true })) },
    mediaCast: {
      findFirst: jest.fn(async () => ({ id: 'cast-1' })),
      count: jest.fn(async () => 2),
    },
    characterVote: {
      findUnique: jest.fn(async () => null),
      groupBy: jest.fn(async () => [{ castId: 'cast-1', _count: { _all: 1 } }]),
      upsert: jest.fn(async () => ({})),
      deleteMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const events = { emit: jest.fn() } as any;
  return { prisma, events, service: new MediaVotesService(withMockTransaction(prisma), events) };
}

describe('MediaVotesService movie character voting', () => {
  it('requires the movie to be watched', async () => {
    const { prisma, service } = setup();
    prisma.userMovieStatus.findUnique.mockResolvedValue(null);
    await expect(service.voteMovieCharacter('u1', 'movie-1', 'cast-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.characterVote.upsert).not.toHaveBeenCalled();
  });

  it('rejects a cast credit belonging to another title', async () => {
    const { prisma, service } = setup();
    prisma.mediaCast.findFirst.mockResolvedValue(null);
    await expect(
      service.voteMovieCharacter('u1', 'movie-1', 'foreign-cast'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates or changes the one active vote and returns aggregate counts', async () => {
    const { prisma, service } = setup();
    prisma.characterVote.findUnique.mockResolvedValue({ castId: 'cast-1' });
    const section = await service.voteMovieCharacter('u1', 'movie-1', 'cast-1');
    expect(prisma.characterVote.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'u1', mediaId: 'movie-1' } },
      create: { userId: 'u1', mediaId: 'movie-1', castId: 'cast-1', source: 'MANUAL' },
      update: { castId: 'cast-1', source: 'MANUAL', sourceKey: null },
    });
    expect(section).toEqual({
      userVote: 'cast-1',
      total: 1,
      options: [{ castId: 'cast-1', count: 1 }],
    });
  });

  it('removes the active vote when value is null', async () => {
    const { prisma, service } = setup();
    await service.voteMovieCharacter('u1', 'movie-1', null);
    expect(prisma.characterVote.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1', mediaId: 'movie-1' },
    });
  });
});

describe('local detail interaction reads', () => {
  it.each(['SHOW', 'MOVIE'] as const)(
    'does not wait for a stuck community provider when loading %s local votes',
    async (type) => {
      const { prisma, events } = setup();
      prisma.rating = {
        findUnique: jest.fn().mockResolvedValue({ rating: 4 }),
        groupBy: jest.fn().mockResolvedValue([{ rating: 4, _count: { _all: 2 } }]),
      };
      prisma.reaction = {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([]),
      };
      const community = { merge: jest.fn(() => new Promise(() => {})) };
      const service = new MediaVotesService(
        withMockTransaction(prisma),
        events,
        undefined,
        community as any,
      );
      const result =
        type === 'SHOW'
          ? await service.getShowInteractions('media', 'viewer', false)
          : await service.getMovieInteractions('media', 'viewer', false);
      expect(result.rating).toMatchObject({ userVote: '4', total: 2 });
      expect(community.merge).not.toHaveBeenCalled();
    },
  );
});
