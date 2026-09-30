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
import { TrackingService } from './tracking.service';

function setup() {
  const status: any = {
    watched: true,
    watchCount: 1,
    source: 'TVTIME',
    device: 'TV',
    deviceSource: 'TVTIME',
  };
  const db: any = {
    mediaCanonicalCopy: { findFirst: jest.fn().mockResolvedValue(null) },
    episode: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'episode',
        structureState: 'RETIRED',
        season: { number: 1, show: { mediaId: 'show' } },
      }),
    },
    userEpisodeStatus: {
      findUnique: jest.fn(async () => status),
      update: jest.fn(async ({ data }) => {
        Object.assign(status, data);
        return status;
      }),
    },
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 'movie', movie: { runtimeMinutes: 120 } }),
    },
    userMovieStatus: {
      findUnique: jest.fn(async () => status),
      upsert: jest.fn(),
      update: jest.fn(),
    },
    watchHistory: { create: jest.fn().mockResolvedValue({ id: 'history', watchedAt: new Date() }) },
    userShowStatus: { findUnique: jest.fn().mockResolvedValue(null) },
    rating: { upsert: jest.fn() },
    reaction: { upsert: jest.fn() },
  };
  const publication: any = {
    voteTransaction: jest.fn(async (_user, _type, _id, _kind, _value, _selected, change) =>
      change(db),
    ),
    captureVote: jest.fn(),
  };
  const redis: any = { client: { incr: jest.fn() }, delByPattern: jest.fn(), del: jest.fn() };
  const service = new TrackingService(
    withMockTransaction(db),
    { emit: jest.fn() } as any,
    redis,
    publication,
  );
  return { service, db, status, publication };
}
it('does not turn an imported device into a new vote when rewatching', async () => {
  const f = setup();
  await f.service.rewatchEpisode('user', 'episode');
  expect(f.status.source).toBe('MANUAL');
  expect(f.status.deviceSource).toBe('TVTIME');
  expect(f.status.device).toBe('TV');
  expect(f.publication.voteTransaction).not.toHaveBeenCalled();
  expect(f.publication.captureVote).not.toHaveBeenCalled();
});
it('publishes only explicitly supplied feedback and preserves independent watch provenance', async () => {
  const f = setup();
  await f.service.updateEpisodeFeedback('user', 'episode', {
    rating: 4,
    reaction: 'AMUSED',
    device: 'TV',
  });
  expect(f.publication.voteTransaction.mock.calls.map((args: any[]) => args.slice(1, 6))).toEqual([
    ['EPISODE', 'episode', 'star_rating', '4', true],
    ['EPISODE', 'episode', 'emotion', 'AMUSED', true],
    ['EPISODE', 'episode', 'watch_device', 'TV', true],
  ]);
  expect(f.status.source).toBe('TVTIME');
  expect(f.status.deviceSource).toBe('MANUAL');
  expect(f.db.reaction.upsert.mock.calls[0][0].update).toMatchObject({
    source: 'MANUAL',
    sourceKey: null,
  });
});
it('captures supplied feedback even when a movie is already watched, without duplicating history', async () => {
  const f = setup();
  await f.service.markMovieWatched('user', 'movie', { rating: 3, device: 'TV' });
  expect(f.publication.voteTransaction.mock.calls.map((args: any[]) => args.slice(1, 6))).toEqual([
    ['MOVIE', 'movie', 'watch_device', 'TV', true],
    ['MOVIE', 'movie', 'star_rating', '3', true],
  ]);
  expect(f.db.watchHistory.create).not.toHaveBeenCalled();
});
it('uses the existing bulk transaction for device state and its outbound intent', async () => {
  const f = setup();
  await (f.service as any).setDevice('user', 'EPISODE', 'episode', 'TV', f.db);
  expect(f.publication.voteTransaction).not.toHaveBeenCalled();
  expect(f.publication.captureVote).toHaveBeenCalledWith(
    f.db,
    'user',
    'EPISODE',
    'episode',
    'watch_device',
    'TV',
    true,
  );
});
it('rejects invalid feedback before mutating or capturing a vote', async () => {
  const f = setup();
  await expect(
    f.service.updateEpisodeFeedback('user', 'episode', { reaction: 'unknown' }),
  ).rejects.toThrow('Invalid reaction');
  expect(f.publication.voteTransaction).not.toHaveBeenCalled();
});
