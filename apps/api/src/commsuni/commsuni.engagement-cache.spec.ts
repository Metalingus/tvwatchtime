import { CommsUniError } from './commsuni.client';
import { CommsUniVotingService } from './commsuni.voting.service';
import { acknowledgedCounts, voteActorDigest } from './commsuni.vote-receipts';

jest.mock('../common/client-capabilities', () => ({ isLegacyClientRequest: () => false }));

const engagement = (count: number, selected = true) => ({
  available: true,
  writesEnabled: false,
  entity: { type: 'episode', id: 'entity-1', reference: 'tvdb-1-s1e1' },
  rating: { average: 4, count: 10, viewerRating: 5 },
  sections: [
    {
      kind: 'cast_vote',
      options: [
        {
          key: 'actor:1',
          label: 'Elisabeth Moss',
          role: 'June',
          count,
          selected,
          imageUrl: null,
          localValue: null,
          archivedCreditId: 'credit-june',
        },
      ],
    },
  ],
});

function setup() {
  const store = new Map<string, unknown>();
  const redis = {
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => void store.set(key, value)),
  };
  const reads = { engagement: jest.fn() };
  const prisma: any = {
    commsUniOutbox: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
    commsUniVoteReceipt: { findMany: jest.fn(async () => []) },
    characterVote: { groupBy: jest.fn(async () => []), findFirst: jest.fn(async () => null) },
  };
  const client: any = { enabled: true, scope: 'scope-1', voteScope: 'vote-1', actor: () => 'a' };
  const service = new CommsUniVotingService(client, reads as any, prisma, redis as any);
  const local = { character: { options: [], total: 0, userVote: null } } as any;
  const character = async (opts?: { cached?: boolean }) =>
    (await service.merge('user-1', 'EPISODE', 'ep-1', local, opts)).character as any;
  return { store, redis, reads, character };
}

describe('CommsUni shared engagement cache', () => {
  it('reuses counts for a minute on reads, but votes always read live', async () => {
    const f = setup();
    f.reads.engagement.mockResolvedValue(engagement(8308, false));
    expect((await f.character({ cached: true })).options).toEqual([
      { castId: 'credit-june', count: 8308 },
    ]);
    await f.character({ cached: true });
    expect(f.reads.engagement).toHaveBeenCalledTimes(1);
    await f.character();
    expect(f.reads.engagement).toHaveBeenCalledTimes(2);
  });

  it('serves the last good counts while the provider refuses reads (quota, 5xx)', async () => {
    const f = setup();
    f.reads.engagement.mockResolvedValueOnce(engagement(8308, false));
    await f.character();
    f.reads.engagement.mockRejectedValue(new CommsUniError(429, 'quota_exceeded', 'daily_budget'));
    const section = await f.character();
    expect(section.aggregateSource).toBe('commsuni');
    expect(section.options).toEqual([{ castId: 'credit-june', count: 8308 }]);
  });

  it('falls back to local counts when there is no previous copy or the error is not an outage', async () => {
    const f = setup();
    f.reads.engagement.mockRejectedValue(new CommsUniError(429, 'quota_exceeded'));
    expect((await f.character()).aggregateSource).toBeUndefined();
    f.reads.engagement.mockResolvedValueOnce(engagement(5));
    await f.character();
    f.reads.engagement.mockRejectedValue(new CommsUniError(404, 'not_found'));
    expect((await f.character()).aggregateSource).toBeUndefined();
  });

  it('never stores one viewer’s selections in the shared copy', async () => {
    const f = setup();
    f.reads.engagement.mockResolvedValue(engagement(3, true));
    await f.character();
    const [, stored] = f.redis.set.mock.calls[0] as [string, any];
    expect(stored.data.rating.viewerRating).toBeNull();
    expect(stored.data.sections[0].options[0].selected).toBe(false);
    expect(stored.data.sections[0].options[0].archivedCreditId).toBe('credit-june');
  });
});

it('counts the viewer from receipts when the options carry no viewer state', () => {
  const receipts = [
    {
      kind: 'cast_vote',
      actorDigest: voteActorDigest('viewer'),
      sequence: 1,
      selectedKeys: ['actor:1'],
    },
  ] as any;
  expect(acknowledgedCounts(receipts, 'cast_vote', 'viewer', [], false).size).toBe(0);
  expect(acknowledgedCounts(receipts, 'cast_vote', 'viewer', [], true).get('actor:1')).toBe(1);
});
