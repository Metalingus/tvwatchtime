import { QueryClient } from '@tanstack/react-query';
import type {
  EpisodeDetailDto,
  ConversationCountDto,
  EpisodeInteractionsDto,
} from '@tvwatch/shared';
import {
  mergeLocalDetail,
  applyCommunityCount,
  applyCommunityInteractions,
} from './detail-community-cache';

const section = (userVote: string | null = null, total = 2) => ({
  userVote,
  total,
  options: [{ value: '4', count: total }],
});
function detail(): EpisodeDetailDto {
  return {
    id: 'episode',
    title: 'Local title',
    watchedAt: '2026-09-13',
    communityDetailsDeferred: true,
    commentsCount: 3,
    commentsCountApproximate: false,
    cast: [{ creditId: 'cast', name: 'Character', votes: 0, characterImageUrl: null }],
    interactions: {
      rating: section(),
      device: section('TV'),
      reaction: { userVotes: [], total: 0, options: [] },
      character: null,
    },
  } as unknown as EpisodeDetailDto;
}
const count: ConversationCountDto = {
  threadType: 'EPISODE',
  threadId: 'episode',
  total: 43,
  approximate: true,
  source: 'commsuni',
};
const shared = {
  rating: { ...section(null, 60), aggregateSource: 'commsuni' as const },
  device: { ...section('TV', 40), aggregateSource: 'commsuni' as const },
};

it('updates counts without changing local metadata, watch status or votes', () => {
  const local = detail();
  const result = applyCommunityCount(local, local, count)!;
  expect(result.commentsCount).toBe(43);
  expect(result.commentsCountApproximate).toBe(true);
  expect(result.watchedAt).toBe(local.watchedAt);
  expect(result.interactions).toBe(local.interactions);
});
it('keeps local data on provider fallback and accepts a valid remote zero', () => {
  const local = detail();
  expect(applyCommunityCount(local, local, { ...count, source: 'local', total: 3 })).toBe(local);
  expect(applyCommunityCount(local, local, { ...count, total: 0 })?.commentsCount).toBe(0);
});
it('discards counts after navigation but accepts them after a local detail refresh', () => {
  const local = detail();
  const other = { ...local, id: 'next' };
  expect(applyCommunityCount(other, local, count)).toBe(other);
  const added = { ...local, commentsCount: 4 };
  expect(applyCommunityCount(added, local, count)).toMatchObject({
    commentsCount: 43,
    commentsCountSource: 'commsuni',
  });
});
it('does not overwrite a changed rating while updating untouched sections', () => {
  const baseline = detail();
  const current = {
    ...baseline,
    interactions: { ...baseline.interactions, rating: section('5', 3) },
  };
  const result = applyCommunityInteractions(current, baseline, 'episode', shared)!;
  expect(result.interactions.rating).toBe(current.interactions.rating);
  expect(result.interactions.device).toBe(shared.device);
});
it('rejects interactions for a different media and keeps local fallback sections', () => {
  const local = detail();
  expect(applyCommunityInteractions(local, local, 'other', shared)).toBe(local);
  expect(applyCommunityInteractions(local, local, 'episode', { rating: section() })).toBe(local);
});
it('preserves shared totals and stable section references during local artwork polling', () => {
  const qc = new QueryClient();
  const key = ['episode', 'episode'];
  const local = detail();
  const enriched = applyCommunityInteractions(
    applyCommunityCount(local, local, count),
    local,
    'episode',
    shared,
  )!;
  qc.setQueryData(key, enriched);
  const before = qc.getQueryData<EpisodeDetailDto>(key)!;
  const fresh = { ...detail(), title: 'Fresh title', characterArtworkPending: false };
  qc.setQueryData(key, mergeLocalDetail(before, fresh));
  const result = qc.getQueryData<EpisodeDetailDto>(key)!;
  expect(result.title).toBe('Fresh title');
  expect(result.commentsCount).toBe(43);
  expect(result.interactions.rating).toBe(before.interactions.rating);
  expect(result.characterArtworkPending).toBe(false);
  qc.clear();
});
it('uses a changed local selection when refreshing instead of restoring an old shared vote', () => {
  const local = detail();
  const enriched = applyCommunityInteractions(local, local, 'episode', shared)!;
  const fresh = { ...detail(), interactions: { ...local.interactions, rating: section('5') } };
  expect(mergeLocalDetail(enriched, fresh).interactions.rating).toBe(fresh.interactions.rating);
});
it('updates cast vote counts without losing freshly loaded character artwork', () => {
  const local = detail();
  const current = {
    ...local,
    cast: local.cast!.map((row) => ({ ...row, characterImageUrl: 'image' })),
  };
  const character: EpisodeInteractionsDto['character'] = {
    userVote: null,
    total: 25,
    options: [{ castId: 'cast', count: 25 }],
    aggregateSource: 'commsuni',
  };
  const result = applyCommunityInteractions(current, local, 'episode', { character });
  expect(result?.cast?.[0]).toMatchObject({ votes: 25, characterImageUrl: 'image' });
});
