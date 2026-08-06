import { MediaMetadataService } from './media-metadata.service';

function setup() {
  const events = { emitAsync: jest.fn(async () => []) };
  const prisma: any = {
    mediaItem: {
      findFirst: jest.fn(async () => ({
        id: 'movie-1',
        type: 'MOVIE',
        externalIds: [{ provider: 'TMDB', providerEntityKind: 'MOVIE', value: '900' }],
      })),
    },
    mediaCastExternalId: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
    },
    mediaCast: {
      findFirst: jest.fn(async () => ({ sortOrder: 4 })),
      findMany: jest.fn(async () => [
        {
          id: 'cast-1',
          character: 'Hero',
          castMember: { externalId: 'TMDB_44' },
        },
      ]),
      upsert: jest.fn(),
    },
    castMember: { upsert: jest.fn() },
    externalId: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(async () => ({})),
    },
    $queryRaw: jest.fn(async () => [{ characterId: 77 }]),
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const tvdb: any = {
    getCharacter: jest.fn(async () => ({
      id: 77,
      name: 'Hero',
      peopleId: 33,
      personName: 'Actor',
      seriesId: 12,
    })),
    getPersonExtended: jest.fn(async () => ({
      id: 33,
      name: 'Actor',
      remoteIds: [{ id: '44', type: 15, sourceName: 'TheMovieDB.com' }],
      characters: [{ id: 88, name: 'Hero', movieId: 55 }],
    })),
    getMovieIdentity: jest.fn(async () => ({ tvdbId: 55, tmdbId: 900, imdbId: null })),
  };
  const service = new MediaMetadataService(
    prisma,
    {} as any,
    tvdb,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    undefined,
    events as any,
  );
  return { service, prisma, tvdb, events };
}

describe('movie cast enrichment for imported TV Time votes', () => {
  it('proves a series-scoped role through person and TVDB movie cross-identity', async () => {
    const { service, prisma, events } = setup();

    const result = await service.enrichMovieCastForPendingVotes('movie-1');

    expect(result).toEqual({ requested: 1, resolved: 1 });
    expect(prisma.externalId.create).toHaveBeenCalledWith({
      data: {
        mediaId: 'movie-1',
        provider: 'THE_TVDB',
        providerEntityKind: 'MOVIE',
        value: '55',
      },
    });
    expect(prisma.mediaCastExternalId.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          mediaId: 'movie-1',
          castId: 'cast-1',
          value: '77',
        }),
      }),
    );
    expect(events.emitAsync).toHaveBeenCalledWith('metadata.cast-refreshed', {
      mediaId: 'movie-1',
    });
  });

  it('keeps work pending when TVDB fails and does not emit terminal replay', async () => {
    const { service, tvdb, events } = setup();
    tvdb.getCharacter.mockRejectedValue(new Error('tvdb unavailable'));

    await expect(service.enrichMovieCastForPendingVotes('movie-1')).rejects.toThrow(
      'tvdb unavailable',
    );
    expect(events.emitAsync).not.toHaveBeenCalled();
  });
});
