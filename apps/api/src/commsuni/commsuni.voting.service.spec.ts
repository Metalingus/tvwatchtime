import {
  CommsUniVotingService,
  sharedVoteSection,
  sharedReactionSection,
  sharedCharacterSection,
  providerCounts,
} from './commsuni.voting.service';
import { acknowledgedCounts, voteActorDigest, acknowledgeVotes } from './commsuni.vote-receipts';

const option = (value: string | null, archived: number, native = 0, key = 'key:' + value) => ({
  key,
  localValue: value,
  count: archived + native,
  archivedCount: archived,
  nativeCount: native,
  label: String(value),
  selected: false,
  imageUrl: null,
});
const rating = () => ({
  userVote: '4',
  total: 2,
  options: ['1', '2', '3', '4', '5'].map((value) => ({ value, count: value === '4' ? 2 : 0 })),
});
const manual = (...entries: [string, number][]) => new Map(entries);

it('adds every local manual vote to the shared stars', () => {
  const result = sharedVoteSection(
    rating(),
    [option('4', 100), option('5', 200)],
    manual(['4', 2], ['5', 1]),
    '4',
  );
  expect(result).toMatchObject({
    total: 303,
    userVote: '4',
    countedUserVote: '4',
    aggregateSource: 'commsuni',
  });
  expect(result.options.slice(3).map((o) => o.count)).toEqual([102, 201]);
});
it('counts the same population for different viewers', () => {
  const remote = [option('4', 2), option('5', 1)];
  const votes = manual(['4', 1], ['5', 1]);
  const alice = sharedVoteSection(rating(), remote, votes, '4');
  const bob = sharedVoteSection({ ...rating(), userVote: '5' }, remote, votes, '5');
  expect(alice.options).toEqual(bob.options);
  expect(alice.total).toBe(5);
});
it('deducts only acknowledged native votes, never an imported baseline', () => {
  const remote = [option('4', 2, 1), option('5', 1)];
  const result = sharedVoteSection(
    { ...rating(), userVote: '5' },
    remote,
    manual(['5', 1]),
    '5',
    manual(['key:4', 1]),
  );
  expect(result.options.slice(3).map((o) => o.count)).toEqual([2, 2]);
  expect(result.total).toBe(4);
});
it('does not subtract archived counts when a provider rollup trails acknowledgement', () => {
  expect(providerCounts([option('4', 10, 0)], manual(['key:4', 1]))?.get('key:4')).toBe(10);
});
it('does not double-count when a pending contribution is acknowledged', () => {
  const local = manual(['4', 1]);
  const pending = sharedVoteSection(rating(), [option('4', 2)], local, '4');
  const synced = sharedVoteSection(rating(), [option('4', 2, 1)], local, '4', manual(['key:4', 1]));
  expect(synced).toEqual(pending);
});
it('uses selection totals for multiple users and multiple emotions', () => {
  const local = {
    userVotes: ['AMUSED'],
    total: 2,
    options: [
      { value: 'AMUSED', count: 2 },
      { value: 'SHOCKED', count: 1 },
    ],
  };
  const result = sharedReactionSection(
    local,
    [option('AMUSED', 1), option('SHOCKED', 1)],
    manual(['AMUSED', 2], ['SHOCKED', 1]),
    ['AMUSED'],
  );
  expect(result).toMatchObject({ total: 5, totalKind: 'selections', countedUserVotes: ['AMUSED'] });
  expect(result.options.map((o) => o.count)).toEqual([3, 2]);
});
it('keeps imported selections visible without adding them to the archive again', () => {
  const result = sharedVoteSection(rating(), [option('4', 2)], new Map(), null);
  expect(result).toMatchObject({ userVote: '4', countedUserVote: null, total: 2 });
});
it.each(
  [[], [option(null, 2)], [option('4', 1), option('4', 1)], [option('unknown', 3)]].map(
    (options) => ({ options }),
  ),
)('falls back to local stars for an unsafe catalog', ({ options: remote }) => {
  const local = rating();
  expect(sharedVoteSection(local, remote, new Map(), null)).toBe(local);
});
it('rejects duplicate option keys and missing native split when deduction is needed', () => {
  expect(providerCounts([option('4', 2), option('4', 1)], new Map())).toBeNull();
  const noSplit = {
    key: 'a',
    localValue: '4',
    label: 'Great',
    count: 2,
    selected: true,
    imageUrl: null,
  };
  expect(providerCounts([noSplit], manual(['a', 1]))).toBeNull();
});
it('sums independently keyed cast buckets on the same verified credit and retains unmatched counts', () => {
  const remote = [
    option('credit-a', 1, 0, 'actor:11'),
    option('credit-a', 1, 0, 'cast:alias'),
    { ...option(null, 2, 0, 'actor:other'), label: 'Other performer', role: 'Other role' },
  ];
  const result = sharedCharacterSection(
    { userVote: 'credit-a', total: 1, options: [] },
    remote,
    manual(['credit-a', 1]),
    'credit-a',
  );
  expect(result).toMatchObject({
    total: 5,
    options: [{ castId: 'credit-a', count: 3 }],
    countedUserVote: 'credit-a',
    unmappedOptions: [{ key: 'actor:other', count: 2, name: 'Other performer' }],
  });
});
it('uses the latest receipt per actor across aliases and the viewer from the current snapshot', () => {
  const receipts: any[] = [
    {
      actorDigest: voteActorDigest('alice'),
      kind: 'star_rating',
      sequence: 1n,
      selectedKeys: ['old'],
    },
    {
      actorDigest: voteActorDigest('alice'),
      kind: 'star_rating',
      sequence: 2n,
      selectedKeys: ['new'],
    },
    {
      actorDigest: voteActorDigest('bob'),
      kind: 'star_rating',
      sequence: 3n,
      selectedKeys: ['stale'],
    },
  ];
  expect([
    ...acknowledgedCounts(receipts, 'star_rating', 'bob', [
      { ...option('4', 2, 1, 'current'), selected: true },
    ]),
  ]).toEqual([
    ['new', 1],
    ['current', 1],
  ]);
});
it('keeps receipts after account deletion without retaining a local account id', async () => {
  const tx: any = {
    commsUniVoteReceipt: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
  };
  await acknowledgeVotes(
    tx,
    'scope',
    'opaque-actor',
    { entityType: 'episode', reference: 'tvdb-1-s1e1', entityId: 'entity' } as any,
    'star_rating',
    ['rating:3'],
    4n,
  );
  const saved = tx.commsUniVoteReceipt.upsert.mock.calls[0][0].create;
  expect(saved).toMatchObject({
    actorDigest: voteActorDigest('opaque-actor'),
    selectedKeys: ['rating:3'],
    sequence: 4n,
  });
  expect(saved).not.toHaveProperty('userId');
  expect(saved).not.toHaveProperty('actor');
});
it('does not replace a newer receipt with a late acknowledgement', async () => {
  const tx: any = {
    commsUniVoteReceipt: {
      findUnique: jest.fn().mockResolvedValue({ sequence: 10n }),
      upsert: jest.fn(),
    },
  };
  await acknowledgeVotes(
    tx,
    'scope',
    'actor',
    { entityType: 'episode', reference: 'ref' } as any,
    'emotion',
    [],
    9n,
  );
  expect(tx.commsUniVoteReceipt.upsert).not.toHaveBeenCalled();
});

function setup() {
  const client: any = {
    enabled: true,
    writesEnabled: false,
    scope: 'scope',
    voteScope: 'scope',
    actor: (id: string) => id,
    request: jest.fn(),
  };
  const reads: any = {
    engagement: jest.fn().mockResolvedValue({
      available: true,
      entity: { type: 'episode', id: 'entity', reference: 'tvdb-1-s1e1' },
      sections: [{ kind: 'star_rating', options: [option('4', 2)] }],
    }),
  };
  const db: any = {
    commsUniVoteReceipt: { findMany: jest.fn().mockResolvedValue([]) },
    commsUniOutbox: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    rating: {
      findFirst: jest.fn().mockResolvedValue({ rating: 4 }),
      groupBy: jest.fn().mockResolvedValue([{ rating: 4, _count: { _all: 2 } }]),
    },
  };
  return { client, reads, db, service: new CommsUniVotingService(client, reads, db) };
}
it('loads all manual voters but only the current viewer selection, scoped to the exact episode', async () => {
  const f = setup();
  const result = await f.service.merge('viewer', 'EPISODE', 'episode', { rating: rating() });
  expect(result.rating.total).toBe(4);
  expect(f.db.rating.groupBy).toHaveBeenCalledWith({
    by: ['rating'],
    where: { episodeId: 'episode', source: 'MANUAL' },
    _count: { _all: true },
  });
  expect(f.db.rating.findFirst).toHaveBeenCalledWith({
    where: { userId: 'viewer', episodeId: 'episode', source: 'MANUAL' },
    select: { rating: true },
  });
  expect(f.db.commsUniVoteReceipt.findMany).toHaveBeenCalledWith({
    where: {
      scope: 'scope',
      entityType: 'episode',
      OR: [{ entityId: 'entity' }, { reference: 'tvdb-1-s1e1' }],
    },
  });
  expect(f.client.request).not.toHaveBeenCalled();
});
it('supports a read-only installation awaiting receipt migration only when no vote was ever attempted', async () => {
  const f = setup();
  f.db.commsUniVoteReceipt.findMany.mockRejectedValue({ code: 'P2021' });
  const local = { rating: rating() };
  expect((await f.service.merge('viewer', 'EPISODE', 'episode', local)).rating.total).toBe(4);
  f.db.commsUniOutbox.findFirst.mockResolvedValue({ id: 'attempted' });
  expect(await f.service.merge('viewer', 'EPISODE', 'episode', local)).toBe(local);
});
it('falls back on unavailable provider or invalid entity data without mutation', async () => {
  const f = setup();
  const local = { rating: rating() };
  f.reads.engagement.mockResolvedValue({ available: false });
  expect(await f.service.merge('viewer', 'EPISODE', 'episode', local)).toBe(local);
  f.reads.engagement.mockRejectedValue(Error('offline'));
  expect(await f.service.merge('viewer', 'EPISODE', 'episode', local)).toBe(local);
});
it('does not read the provider when disabled or unauthenticated', async () => {
  const f = setup();
  const local = { rating: rating() };
  f.client.enabled = false;
  expect(await f.service.merge('viewer', 'SHOW', 'show', local)).toBe(local);
  f.client.enabled = true;
  expect(await f.service.merge(undefined, 'SHOW', 'show', local)).toBe(local);
  expect(f.reads.engagement).not.toHaveBeenCalled();
});

it('does not double-count another user whose provider write has no saved acknowledgement yet', async () => {
  const f = setup();
  const local = { rating: rating() };
  f.db.commsUniOutbox.findMany.mockResolvedValue([
    { path: '/entities/episode/entity/engagement/star_rating' },
  ]);
  const result = await f.service.merge('viewer', 'EPISODE', 'episode', local);
  expect(result.rating).toBe(local.rating);
  expect(result.rating).not.toHaveProperty('aggregateSource');
});

it('keeps character percentage tie-breaking stable when database or provider rows arrive in another order', () => {
  const local = { userVote: 'a', total: 0, options: [] };
  const one = sharedCharacterSection(
    local,
    [option('b', 1, 0, 'b'), option('a', 1, 0, 'a')],
    manual(['b', 1], ['a', 1]),
    'a',
  );
  const two = sharedCharacterSection(
    local,
    [option('a', 1, 0, 'a'), option('b', 1, 0, 'b')],
    manual(['a', 1], ['b', 1]),
    'a',
  );
  expect(one.options).toEqual(two.options);
});

it('does not count an imported device again after a watch-only provenance change', async () => {
  const f = setup();
  const status = { source: 'TVTIME', deviceSource: 'TVTIME', device: 'TV' };
  f.db.userEpisodeStatus = {
    groupBy: jest.fn(async ({ where }) =>
      status.deviceSource === where.deviceSource ? [{ device: 'TV', _count: { _all: 1 } }] : [],
    ),
    findFirst: jest.fn(async ({ where }) =>
      status.deviceSource === where.deviceSource ? { device: 'TV' } : null,
    ),
  };
  f.reads.engagement.mockResolvedValue({
    available: true,
    entity: { type: 'episode', id: 'entity', reference: 'tvdb-1-s1e1' },
    sections: [{ kind: 'watch_device', options: [option('TV', 100)] }],
  });
  const local = {
    device: { userVote: 'TV', total: 1, options: [{ value: 'TV', count: 1, percentage: 100 }] },
  };
  const before = await f.service.merge('viewer', 'EPISODE', 'episode', local);
  status.source = 'MANUAL';
  const after = await f.service.merge('viewer', 'EPISODE', 'episode', local);
  expect(before.device.total).toBe(100);
  expect(after.device.total).toBe(100);
  expect(after.device).toMatchObject({ countedUserVote: null });
  status.deviceSource = 'MANUAL';
  expect((await f.service.merge('viewer', 'EPISODE', 'episode', local)).device.total).toBe(101);
});

it.each([false, true])(
  'treats a failed vote as uncertain only when delivery may have changed provider state (%s)',
  async (uncertain) => {
    const db: any = {
      commsUniOutbox: {
        findMany: jest.fn(async () => [
          {
            path: '/entities/episode/entity/engagement/star_rating',
            target: { deliveryUncertain: uncertain },
          },
        ]),
      },
      commsUniVoteReceipt: { findMany: async () => [] },
      rating: {
        groupBy: async () => [{ rating: 4, _count: { _all: 2 } }],
        findFirst: async () => ({ rating: 4 }),
      },
    };
    const reads: any = {
      engagement: async () => ({
        available: true,
        entity: { type: 'episode', id: 'entity', reference: 'tvdb-1-s1e1' },
        sections: [{ kind: 'star_rating', options: [option('4', 100)] }],
      }),
    };
    const service = new CommsUniVotingService(
      { enabled: true, scope: 'scope', voteScope: 'scope', actor: (id: string) => id } as any,
      reads,
      db,
    );
    const result = await service.merge('another-viewer', 'EPISODE', 'episode', {
      rating: rating(),
    });
    expect(result.rating.total).toBe(uncertain ? 2 : 102);
    expect(db.commsUniOutbox.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ identity: { scope: 'scope' } }),
      }),
    );
  },
);
it('uses a later acknowledged selection to resolve an older partial attempt', async () => {
  const db: any = {
    commsUniOutbox: {
      findMany: async () => [
        {
          path: '/entities/episode/entity/engagement/star_rating',
          target: { deliveryUncertain: true },
          identity: { userId: 'writer' },
          sequence: 1n,
        },
      ],
    },
    commsUniVoteReceipt: {
      findMany: async () => [
        {
          actorDigest: voteActorDigest('writer'),
          sequence: 2n,
          kind: 'star_rating',
          selectedKeys: [],
        },
      ],
    },
    rating: {
      groupBy: async () => [{ rating: 4, _count: { _all: 2 } }],
      findFirst: async () => ({ rating: 4 }),
    },
  };
  const reads: any = {
    engagement: async () => ({
      available: true,
      entity: { type: 'episode', id: 'entity', reference: 'tvdb-1-s1e1' },
      sections: [{ kind: 'star_rating', options: [option('4', 100)] }],
    }),
  };
  const service = new CommsUniVotingService(
    { enabled: true, scope: 'scope', voteScope: 'scope', actor: (id: string) => id } as any,
    reads,
    db,
  );
  expect(
    (await service.merge('viewer', 'EPISODE', 'episode', { rating: rating() })).rating.total,
  ).toBe(102);
});
