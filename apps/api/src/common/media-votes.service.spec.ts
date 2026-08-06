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
  return { prisma, service: new MediaVotesService(prisma) };
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
      create: { userId: 'u1', mediaId: 'movie-1', castId: 'cast-1' },
      update: { castId: 'cast-1' },
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
