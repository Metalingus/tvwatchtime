import { QueryClient, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import type { EpisodeDetailDto } from '@tvwatch/shared';
import { getBaseUrl, request } from './client';
import { useDetailCommunity } from './use-detail-community';
import { mergeLocalDetail } from './detail-community-cache';

jest.mock('./client', () => ({
  getBaseUrl: jest.fn(async () => 'https://api.example.test'),
  request: jest.fn(),
}));
jest.mock('@tanstack/react-query', () => ({
  ...jest.requireActual('@tanstack/react-query'),
  useQuery: jest.fn(),
  useQueryClient: jest.fn(),
}));
function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const key = ['episode', 'episode'];
let qc: QueryClient;
let options: UseQueryOptions[];
let local: EpisodeDetailDto;
beforeEach(() => {
  jest.clearAllMocks();
  (getBaseUrl as jest.Mock).mockResolvedValue('https://api.example.test');
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  (useQueryClient as jest.Mock).mockReturnValue(qc);
  options = [];
  (useQuery as jest.Mock).mockImplementation((value) => {
    options.push(value);
    return { refetch: () => qc.fetchQuery(value) };
  });
  local = {
    id: 'episode',
    title: 'Local',
    commentsCount: 3,
    communityDetailsDeferred: true,
    interactions: { rating: { userVote: null, total: 0, options: [] } },
  } as unknown as EpisodeDetailDto;
  qc.setQueryData(key, local);
  qc.setQueryData(['me'], { id: 'viewer' });
});
afterEach(() => qc.clear());
function start() {
  useDetailCommunity(key, 'EPISODE', local, true, 'viewer');
  return options.map((option) => qc.fetchQuery(option as any));
}
const remoteCount = {
  threadType: 'EPISODE',
  threadId: 'episode',
  total: 80,
  approximate: false,
  source: 'commsuni',
};
it('keeps the screen ready and applies counts while votes are still unresolved', async () => {
  const counts = deferred();
  const votes = deferred();
  (request as jest.Mock).mockImplementation((url) =>
    url.endsWith('/counts') ? counts.promise : votes.promise,
  );
  const [countRequest, voteRequest] = start();
  expect(qc.getQueryState(key)?.status).toBe('success');
  expect(qc.getQueryData(key)).toEqual(local);
  counts.resolve(remoteCount);
  await countRequest;
  expect(qc.getQueryData<EpisodeDetailDto>(key)?.commentsCount).toBe(80);
  expect(qc.getQueryState(key)?.fetchStatus).toBe('idle');
  // Artwork/detail cache updates do not start new remote calls.
  qc.setQueryData(key, (old: any) => ({ ...old, title: 'Artwork loaded' }));
  expect(request).toHaveBeenCalledTimes(2);
  votes.resolve({ rating: { userVote: null, total: 9, options: [], aggregateSource: 'commsuni' } });
  await voteRequest;
  expect(qc.getQueryData<EpisodeDetailDto>(key)?.interactions.rating.total).toBe(9);
  expect(qc.getQueryData<EpisodeDetailDto>(key)?.title).toBe('Artwork loaded');
});
it('keeps the main query successful when both community requests fail', async () => {
  (request as jest.Mock).mockRejectedValue(new Error('provider timeout'));
  await Promise.allSettled(start());
  expect(qc.getQueryData(key)).toEqual(local);
  expect(qc.getQueryState(key)?.status).toBe('success');
});
it.each(['cancelled', 'account', 'backend', 'removed'] as const)(
  'ignores a late response after the request scope is %s',
  async (mode) => {
    const pending = deferred();
    (request as jest.Mock).mockReturnValue(pending.promise);
    const requests = start();
    const settled = Promise.allSettled(requests);
    // Let both query functions capture their original backend.
    await Promise.resolve();
    await Promise.resolve();
    if (mode === 'cancelled') await qc.cancelQueries({ queryKey: key });
    if (mode === 'account') qc.setQueryData(['me'], { id: 'next-viewer' });
    if (mode === 'backend')
      (getBaseUrl as jest.Mock).mockResolvedValue('https://other.example.test');
    if (mode === 'removed') {
      qc.removeQueries({ queryKey: key, exact: true });
      qc.setQueryData(key, local);
    }
    pending.resolve(remoteCount);
    await settled;
    await Promise.resolve();
    expect(qc.getQueryData(key)).toEqual(local);
  },
);
it('does not enable enrichment for placeholder/old-server details, disabled reads, or no viewer', () => {
  useDetailCommunity(
    key,
    'EPISODE',
    { ...local, communityDetailsDeferred: undefined },
    true,
    'viewer',
  );
  useDetailCommunity(key, 'EPISODE', local, false, 'viewer');
  useDetailCommunity(key, 'EPISODE', local, true, undefined);
  expect(options.every((option) => option.enabled === false)).toBe(true);
});

it('applies the shared result when a local detail refresh changes the cached count first', async () => {
  const counts = deferred();
  const votes = deferred();
  (request as jest.Mock).mockImplementation((url) =>
    url.endsWith('/counts') ? counts.promise : votes.promise,
  );
  const [countRequest, voteRequest] = start();
  // This happens on navigation with cached detail: the local detail request and
  // community count request run independently. The local refresh finishes first.
  await qc.fetchQuery({
    queryKey: key,
    queryFn: async () =>
      mergeLocalDetail(qc.getQueryData<EpisodeDetailDto>(key), {
        ...local,
        title: 'Fresh local title',
        commentsCount: 1,
      }),
    staleTime: 0,
  });
  expect(qc.getQueryData<EpisodeDetailDto>(key)?.commentsCount).toBe(1);
  counts.resolve({ ...remoteCount, total: 422, approximate: true });
  await countRequest;
  expect(qc.getQueryData<EpisodeDetailDto>(key)).toMatchObject({
    title: 'Fresh local title',
    commentsCount: 422,
    commentsCountApproximate: true,
    commentsCountSource: 'commsuni',
  });
  votes.resolve({});
  await voteRequest;
});
