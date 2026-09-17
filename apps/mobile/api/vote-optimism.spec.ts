import {
  recomputeVoteSection,
  recomputeReactionSection,
  recomputeCharacterSection,
  restoreVoteSection,
} from './vote-optimism';

it('changes shared stars immediately without losing metadata', () => {
  const start = {
    aggregateSource: 'commsuni' as const,
    countedUserVote: '5',
    userVote: '5',
    total: 3,
    options: ['1', '2', '3', '4', '5'].map((value) => ({ value, count: value === '5' ? 3 : 0 })),
  };
  const next = recomputeVoteSection(start, '4');
  expect(next).toMatchObject({
    userVote: '4',
    countedUserVote: '4',
    total: 3,
    aggregateSource: 'commsuni',
  });
  expect(next.options.map((o) => o.count)).toEqual([0, 0, 0, 1, 2]);
  expect(recomputeVoteSection(next, '3').options.map((o) => o.count)).toEqual([0, 0, 1, 0, 2]);
});
it('keeps the archived imported choice when the viewer makes their first manual vote', () => {
  const start = {
    aggregateSource: 'commsuni' as const,
    countedUserVote: null,
    userVote: '5',
    total: 2,
    options: [
      { value: '4', count: 0 },
      { value: '5', count: 2 },
    ],
  };
  expect(recomputeVoteSection(start, '4')).toMatchObject({
    total: 3,
    options: [
      { value: '4', count: 1 },
      { value: '5', count: 2 },
    ],
  });
});
it('toggles shared reactions with a selection denominator', () => {
  const start = {
    aggregateSource: 'commsuni' as const,
    totalKind: 'selections' as const,
    countedUserVotes: ['AMUSED'],
    userVotes: ['AMUSED'],
    total: 4,
    options: [
      { value: 'SHOCKED', count: 1 },
      { value: 'AMUSED', count: 2 },
      { value: 'THRILLED', count: 1 },
    ],
  };
  const next = recomputeReactionSection(start, 'SHOCKED');
  expect(next).toMatchObject({
    total: 5,
    userVotes: ['AMUSED', 'SHOCKED'],
    countedUserVotes: ['AMUSED', 'SHOCKED'],
    totalKind: 'selections',
  });
  expect(next.options.map((o) => o.count)).toEqual([2, 2, 1]);
  expect(recomputeReactionSection(next, 'AMUSED').options.map((o) => o.count)).toEqual([2, 1, 1]);
});
it('removing an imported reaction leaves archived counts untouched', () => {
  const start = {
    aggregateSource: 'commsuni' as const,
    countedUserVotes: [],
    userVotes: ['AMUSED'],
    total: 1,
    options: [{ value: 'AMUSED', count: 1 }],
  };
  expect(recomputeReactionSection(start, 'AMUSED')).toMatchObject({
    total: 1,
    userVotes: [],
    options: start.options,
  });
});
it('retains native distinct-user totals for ordinary local reactions', () => {
  const start = {
    userVotes: ['AMUSED'],
    total: 1,
    options: [
      { value: 'AMUSED', count: 1 },
      { value: 'SHOCKED', count: 0 },
    ],
  };
  const next = recomputeReactionSection(start, 'SHOCKED');
  expect(next.total).toBe(1);
  expect(next.options.map((o) => o.count)).toEqual([1, 1]);
});
it('does not guess contributions in an older provider response', () => {
  const start = {
    aggregateSource: 'commsuni' as const,
    userVote: '5',
    total: 2,
    options: [{ value: '5', count: 2 }],
  };
  expect(recomputeVoteSection(start, '4')).toEqual({ ...start, userVote: '4' });
});

it('changes and clears a shared character vote without discarding unmatched provider counts', () => {
  const initial = {
    aggregateSource: 'commsuni' as const,
    userVote: 'a',
    countedUserVote: 'a',
    total: 6,
    options: [
      { castId: 'a', count: 3 },
      { castId: 'b', count: 1 },
    ],
    unmappedOptions: [
      { key: 'actor:other', name: 'Other', character: null, imageUrl: null, count: 2 },
    ],
  };
  const next = recomputeCharacterSection(initial, 'b');
  expect(next).toMatchObject({
    total: 6,
    userVote: 'b',
    countedUserVote: 'b',
    options: [
      { castId: 'a', count: 2 },
      { castId: 'b', count: 2 },
    ],
    unmappedOptions: initial.unmappedOptions,
  });
  expect(recomputeCharacterSection(next, null)).toMatchObject({ total: 5, countedUserVote: null });
});
it('does not subtract an imported character choice from the archived baseline', () => {
  const section = {
    aggregateSource: 'commsuni' as const,
    userVote: 'a',
    countedUserVote: null,
    total: 2,
    options: [{ castId: 'a', count: 2 }],
  };
  expect(recomputeCharacterSection(section, 'b')).toMatchObject({
    total: 3,
    options: [
      { castId: 'a', count: 2 },
      { castId: 'b', count: 1 },
    ],
  });
});

it('rolls back a failed rating without undoing a concurrent emotion vote or refreshed metadata', () => {
  const previous = {
    title: 'old',
    interactions: {
      rating: { userVote: '4', total: 1, options: [{ value: '4', count: 1 }] },
      reaction: { userVotes: [], total: 0, options: [{ value: 'AMUSED', count: 0 }] },
    },
  };
  const current = {
    title: 'refreshed',
    interactions: {
      rating: recomputeVoteSection(previous.interactions.rating, '5'),
      reaction: recomputeReactionSection(previous.interactions.reaction, 'AMUSED'),
    },
  };
  const result = restoreVoteSection(current, previous, 'rating')!;
  expect(result.title).toBe('refreshed');
  expect(result.interactions.rating).toBe(previous.interactions.rating);
  expect(result.interactions.reaction).toBe(current.interactions.reaction);
});
