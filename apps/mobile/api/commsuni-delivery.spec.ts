import React from 'react';
import { QueryClient } from '@tanstack/react-query';
import type { CommentDto, ConversationItemDto } from '@tvwatch/shared';
import { useConversationFeed } from './commsuni';
import { api } from './client';

let mockClient: QueryClient;
let mockPosted: CommentDto[] = [];
let mockItems: ConversationItemDto[] = [];
let mockQueries: any[] = [];
let mockFeedOptions: any;
jest.mock('expo-crypto', () => ({ randomUUID: () => 'action' }));
jest.mock('./client', () => ({
  api: { get: jest.fn() },
  getBaseUrl: jest.fn(async () => 'https://local.example/api'),
}));
jest.mock('./hooks', () => ({ useMe: () => ({ data: { id: 'viewer' } }) }));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQueryClient: () => mockClient,
  useInfiniteQuery: (options: any) => {
    mockFeedOptions = options;
    return { data: { pages: [{ items: mockItems }] } };
  },
  useQueries: ({ queries }: any) => {
    mockQueries = queries;
    return queries.map((q: any) => ({
      data: mockClient.getQueryData(q.queryKey) ?? q.initialData,
    }));
  },
}));
const comment = (state: string, id = 'comment') =>
  ({
    id,
    body: 'Saved text',
    commsUniState: state,
    commsUniCommentId: state === 'SYNCED' ? 'remote' : null,
  }) as CommentDto;
const local = (row: CommentDto): ConversationItemDto => ({
  kind: 'local',
  key: 'local:' + row.id,
  comment: row,
});
function render(enabled = true) {
  return useConversationFeed('MOVIE', 'movie', 'LATEST', undefined, undefined, enabled);
}
beforeEach(() => {
  mockClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  mockPosted = [];
  mockItems = [];
  mockQueries = [];
  jest
    .spyOn(React, 'useState')
    .mockImplementation(((initial: any) => [
      Array.isArray(initial) ? mockPosted : 'https://local.example/api',
      jest.fn(),
    ]) as any);
  jest.spyOn(React, 'useEffect').mockImplementation(() => undefined);
  jest.mocked(api.get).mockReset();
});
afterEach(() => {
  mockClient.clear();
  jest.restoreAllMocks();
});

it('updates a pending comment restored from a feed without a new submission on this mount', async () => {
  mockItems = [local(comment('PENDING'))];
  expect(render().items[0]).toMatchObject({ comment: { commsUniState: 'PENDING' } });
  expect(mockQueries).toHaveLength(1);
  jest.mocked(api.get).mockResolvedValue(comment('SYNCED'));
  await mockClient.fetchQuery(mockQueries[0]);
  expect(api.get).toHaveBeenCalledWith('/comments/comment');
  expect(render().items[0]).toMatchObject({
    comment: { commsUniState: 'SYNCED', commsUniCommentId: 'remote' },
  });
  expect(mockQueries[0].refetchInterval({ state: { data: comment('SYNCED') } })).toBe(false);
  expect(mockFeedOptions.refetchInterval).toBe(false);
});

it('tracks each pending identity once and leaves completed/failed feed rows unpolled', () => {
  mockPosted = [comment('PENDING')];
  mockItems = [
    local(comment('PENDING')),
    local(comment('SYNCED', 'complete')),
    local(comment('FAILED', 'failed')),
  ];
  render();
  expect(mockQueries).toHaveLength(1);
  expect(mockQueries[0].refetchInterval({ state: { data: comment('PENDING') } })).toBe(2000);
  expect(mockQueries[0].refetchInterval({ state: { data: comment('FAILED') } })).toBe(false);
});

it('keeps an acknowledged feed row from being replaced by an older retained pending result', () => {
  mockPosted = [comment('PENDING')];
  mockItems = [local(comment('SYNCED'))];
  expect(render().items).toMatchObject([
    { comment: { commsUniState: 'SYNCED', commsUniCommentId: 'remote' } },
  ]);
});

it('does not replace a completed query-cache result when a delayed create result is retained', () => {
  const key = ['commsuniLocalPost', 'https://local.example/api', 'viewer', 'comment'];
  mockClient.setQueryData(key, comment('SYNCED'));
  render().retain(comment('PENDING'));
  expect(mockClient.getQueryData(key)).toMatchObject({
    commsUniState: 'SYNCED',
    commsUniCommentId: 'remote',
  });
});

it('keeps delivery reads disabled with the feed', () => {
  mockItems = [local(comment('PENDING'))];
  render(false);
  expect(mockQueries[0].enabled).toBe(false);
  expect(api.get).not.toHaveBeenCalled();
});
