import { isCommsUniPending, type CommsUniOperationDto } from '@tvwatch/shared';
import { useEffect, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { useInfiniteQuery, useQuery, useQueries, useQueryClient } from '@tanstack/react-query';
import type {
  CommentSort,
  CommentDto,
  CommsUniOrigin,
  ConversationPageDto,
  ConversationType,
  CommsUniThreadDto,
} from '@tvwatch/shared';
import { api, getBaseUrl } from './client';
import { useMe, useCommentsFeed, useCommentReplies } from './hooks';
import {
  mergePostedComments,
  acknowledgeComment,
  presentConversationItem,
  presentReplies,
  sharedCommentPath,
  type CommentView,
} from './commsuni-presentation';

/** Polls our durable operation record only; this endpoint never contacts CommsUni. */
export function useCommsUniOperation(id: string | null) {
  const scope = useCommsUniScope();
  return useQuery({
    queryKey: ['commsuniOperation', ...scope.key, id],
    queryFn: () => api.get<CommsUniOperationDto>('/conversations/operations/' + id),
    enabled: scope.ready && !!id,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchInterval: (query) =>
      isCommsUniPending(query.state.data?.state ?? 'PENDING') ? 2000 : false,
    refetchOnWindowFocus: true,
  });
}

export function useCommsUniScope() {
  const { data: me } = useMe();
  const [baseUrl, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getBaseUrl().then((url) => {
      if (active) setUrl(url);
    });
    return () => {
      active = false;
    };
  }, [me?.id]);
  return { key: [baseUrl, me?.id ?? null], ready: !!baseUrl && !!me?.id };
}

export function useConversationFeed(
  threadType: ConversationType,
  threadId: string,
  sort: CommentSort,
  parentId?: string,
  source?: string,
  enabled = true,
) {
  const scope = useCommsUniScope();
  const qc = useQueryClient();
  const queryKey = [
    'conversations',
    'local-replies-v1',
    ...scope.key,
    threadType,
    threadId,
    sort,
    parentId ?? null,
    source ?? null,
  ];
  const [posted, setPosted] = useState<CommentDto[]>([]);
  const context = JSON.stringify([...scope.key, threadType, threadId, parentId ?? null]);
  useEffect(() => {
    setPosted([]);
  }, [context]);
  const query = useInfiniteQuery({
    queryKey,
    enabled: enabled && scope.ready && !!threadId,
    queryFn: ({ pageParam }) =>
      api.get<ConversationPageDto>(
        parentId ? '/conversations/comments/' + parentId + '/replies' : '/conversations',
        {
          threadType,
          threadId,
          sort,
          ...(source ? { source } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 30000,
    gcTime: 60000,
    refetchOnWindowFocus: false,
    refetchInterval: false,
    retry: false,
  });
  const pageItems = query.data?.pages.flatMap((page) => page.items) ?? [];
  // Restored/refetched pending rows need the same status updates as posts made on this mount.
  const tracked = [
    ...new Map(
      [
        ...posted,
        ...pageItems.flatMap((item) =>
          item.kind === 'local' && isCommsUniPending(item.comment.commsUniState)
            ? [item.comment]
            : [],
        ),
      ].map((comment) => [comment.id, comment]),
    ).values(),
  ];
  const saved = useQueries({
    queries: tracked.map((comment) => ({
      queryKey: ['commsuniLocalPost', ...scope.key, comment.id],
      queryFn: () => api.get<CommentDto>('/comments/' + comment.id),
      initialData: comment,
      enabled: enabled && scope.ready,
      staleTime: 0,
      refetchInterval: (query: { state: { data?: CommentDto } }) =>
        isCommsUniPending(query.state.data?.commsUniState) ? 2000 : (false as const),
      refetchOnWindowFocus: true,
      retry: false,
    })),
  });
  const latest = new Map(
    tracked.map((comment, index) => [
      comment.id,
      acknowledgeComment(saved[index]?.data ?? comment, comment),
    ]),
  );
  const retained = posted.map((comment) =>
    acknowledgeComment(latest.get(comment.id) ?? comment, comment),
  );
  // Keep freshly saved comments visible even if the provider's first page still lags its write.
  const refresh = () => qc.resetQueries({ queryKey, exact: true });
  const retain = (comment: CommentDto) => {
    qc.setQueryData<CommentDto>(['commsuniLocalPost', ...scope.key, comment.id], (known) =>
      acknowledgeComment(comment, known),
    );
    setPosted((current) => [comment, ...current.filter((item) => item.id !== comment.id)]);
  };
  const items = mergePostedComments(
    pageItems.map((item) =>
      item.kind === 'local' && latest.has(item.comment.id)
        ? { ...item, comment: acknowledgeComment(latest.get(item.comment.id)!, item.comment) }
        : item,
    ),
    retained,
  );
  return {
    ...query,
    refresh,
    retain,
    items,
    retained,
  };
}

export function useCommsUniSources(enabled = true) {
  const scope = useCommsUniScope();
  return useQuery({
    queryKey: ['commsuniSources', ...scope.key],
    queryFn: () =>
      api.get<{ sources: CommsUniOrigin[]; ownSource: string | null }>('/conversations/sources'),
    enabled: enabled && scope.ready,
    staleTime: 3600000,
    retry: false,
  });
}

export function useCommsUniThread(
  threadType: ConversationType,
  threadId: string,
  id: string,
  enabled = true,
) {
  const scope = useCommsUniScope();
  return useQuery({
    queryKey: ['commsuniThread', 'local-replies-v1', ...scope.key, threadType, threadId, id],
    enabled: enabled && scope.ready && !!id && !!threadId,
    queryFn: () =>
      api.get<CommsUniThreadDto>('/conversations/comments/' + id, { threadType, threadId }),
    staleTime: 30000,
    gcTime: 60000,
    refetchInterval: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** Both data sources drive the existing feed presentation. Unused queries stay disabled. */
export function useCommentFeed({
  threadType,
  threadId,
  sort,
  shared,
  repliesTo,
  enabled = true,
}: {
  threadType: string;
  threadId: string;
  sort: CommentSort;
  shared: boolean;
  repliesTo?: CommentView | null;
  enabled?: boolean;
}) {
  const { data: catalog } = useCommsUniSources(shared);
  const replyMode = repliesTo !== undefined;
  const ready = enabled && (!replyMode || !!repliesTo);
  const localRoot = useCommentsFeed({
    threadType,
    threadId,
    sort,
    polling: true,
    enabled: ready && !shared && !replyMode,
  });
  const localReplies = useCommentReplies(repliesTo?.id ?? '', sort, {
    polling: true,
    depth: 2,
    enabled: ready && !shared && replyMode,
  });
  const remote = useConversationFeed(
    threadType as ConversationType,
    threadId,
    sort,
    repliesTo?.shared?.comment.id ?? repliesTo?.commsUniCommentId ?? undefined,
    undefined,
    ready && shared,
  );
  const native = replyMode ? localReplies : localRoot;
  const query = shared ? remote : native;
  const localItems = native.data?.pages.flatMap((page) => page.items) ?? [];
  return {
    items: shared
      ? repliesTo
        ? presentReplies(remote.items, repliesTo, catalog?.sources)
        : remote.items.map((item) =>
            presentConversationItem(
              item,
              threadType as ConversationType,
              threadId,
              catalog?.sources,
            ),
          )
      : (mergePostedComments(
          localItems.map((comment) => ({
            kind: 'local' as const,
            key: 'local:' + comment.id,
            comment,
          })),
          remote.retained.map(
            (comment) => localItems.find((row) => row.id === comment.id) ?? comment,
          ),
        ).map((item) => ({
          ...(item as Extract<typeof item, { kind: 'local' }>).comment,
          renderKey: item.key,
        })) as CommentView[]),
    sources: catalog?.sources,
    thread: shared ? remote.data?.pages[0]?.thread : localRoot.data?.pages[0]?.thread,
    total: shared ? undefined : native.data?.pages[0]?.total,
    upstream: shared
      ? remote.data?.pages.find((page) =>
          ['unmapped', 'unavailable', 'throttled'].includes(page.upstream),
        )?.upstream
      : undefined,
    isLoading: ready && (shared ? query.isPending : query.isLoading),
    isError: query.isError,
    isRefetching: query.isRefetching,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetchNextPageError: query.isFetchNextPageError,
    hasNextPage: query.hasNextPage,
    fetchNextPage: () => query.fetchNextPage(),
    refresh: () => (shared ? remote.refresh() : native.refetch()),
    retain: remote.retain,
  };
}

/** Provider-only transport/acknowledgment state; CommentCard owns the common presentation. */
export function useSharedCommentLike(comment: CommentView) {
  const shared = comment.shared;
  const identity = shared
    ? shared.threadType + ':' + shared.threadId + ':' + shared.comment.id
    : '';
  const pending = useRef(false);
  const latestIdentity = useRef(identity);
  latestIdentity.current = identity;
  const [override, setOverride] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const operation = useCommsUniOperation(operationId);
  useEffect(() => {
    pending.current = false;
    setOverride(null);
    setBusy(false);
    setError(false);
    setOperationId(null);
  }, [identity]);
  useEffect(() => {
    const state = operation.data?.state;
    if (state && !['PENDING', 'RETRY', 'SENDING', 'SYNCED'].includes(state)) {
      setOverride(null);
      setError(true);
      setOperationId(null);
    }
    if (state === 'SYNCED') setOperationId(null);
  }, [operation.data?.state]);
  useEffect(() => {
    if (override === shared?.comment.viewerLiked) setOverride(null);
  }, [shared?.comment.viewerLiked, override]);
  const liked = override ?? comment.likedByMe;
  return {
    liked,
    count: Math.max(
      0,
      comment.likesCount + (override == null ? 0 : Number(liked) - Number(comment.likedByMe)),
    ),
    busy: busy || !!operationId,
    error,
    toggle: async () => {
      if (!shared?.comment.actions.like || pending.current || busy || operationId) return;
      pending.current = true;
      setBusy(true);
      setError(false);
      try {
        const result = await api.post<{ operationId?: string }>(
          sharedCommentPath(shared, '/actions'),
          { action: liked ? 'unlike' : 'like', actionId: randomUUID() },
        );
        if (latestIdentity.current !== identity) return;
        setOverride(!liked);
        setOperationId(result.operationId ?? null);
      } catch {
        if (latestIdentity.current === identity) setError(true);
      } finally {
        if (latestIdentity.current === identity) {
          pending.current = false;
          setBusy(false);
        }
      }
    },
  };
}
