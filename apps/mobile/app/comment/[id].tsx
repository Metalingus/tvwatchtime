import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, View, type ViewToken } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { Paginated, ConversationPageDto, MyCommentContextDto } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { SortBar } from '../../components/comments/SortBar';
import { CommentCard } from '../../components/comments/CommentCard';
import { NodeContent, ThreadNode, type ThreadHandlers } from '../../components/comments/ThreadNode';
import { CommentComposer } from '../../components/comments/CommentComposer';
import { CommentEditDialog } from '../../components/comments/CommentEditDialog';
import { CommentActions } from '../../components/comments/CommentActions';
import { useCommentActions } from '../../components/comments/useCommentActions';
import { feedColumn } from '../../components/comments/layout';
import {
  buildChildrenMap,
  threadContextLabel,
  type ExpandedNode,
} from '../../components/comments/thread-utils';
import { activateMediaKeys } from '../../components/comments/media-layout';
import {
  useComment,
  useFeatureFlags,
  useMe,
  useToggleCommentLike,
  useToggleExternalReviewLike,
  type CommentSortMode,
} from '../../api/hooks';
import { useCommentFeed, useCommsUniThread } from '../../api/commsuni';
import {
  commentCanReply,
  commentReplyTarget,
  parseSharedThread,
  presentThreadComment,
  presentReplies,
  type CommentView,
} from '../../api/commsuni-presentation';
import { api } from '../../api/client';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

export default function CommentThreadScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common', 'groups']);
  const params = useLocalSearchParams<{
    id: string;
    source?: string;
    threadType?: string;
    threadId?: string;
    highlight?: string;
  }>();
  const requestedShared = params.source != null;
  const contextKey = JSON.stringify([params.id, params.source, params.threadType, params.threadId]);
  const contextRef = useRef(contextKey);

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  contextRef.current = contextKey + ':' + sort;
  const [editing, setEditing] = useState<CommentView | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, ExpandedNode>>({});
  const [replyTarget, setReplyTarget] = useState<CommentView | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(params.highlight ?? null);
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const listRef = useRef<FlatList<CommentView>>(null);
  const didScrollToHighlight = useRef(false);
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 1 }).current;
  const viewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) =>
    setVisible((previous) =>
      activateMediaKeys(
        previous,
        viewableItems.map((item) => item.item.id),
      ),
    ),
  ).current;
  const { data: me } = useMe();
  const flagQuery = useFeatureFlags();
  const flags = flagQuery.data;
  // A provider UUID is never used against /comments/:localId, even for a malformed deep link.
  const localRoot = useComment(params.id, false, !requestedShared);
  const reference =
    parseSharedThread(params) ??
    (!requestedShared &&
    localRoot.data?.commsUniCommentId &&
    !localRoot.data.deletedByUser &&
    localRoot.data.threadType !== 'GROUP'
      ? {
          id: localRoot.data.commsUniCommentId,
          threadType: localRoot.data.threadType,
          threadId: localRoot.data.threadId,
        }
      : null);
  const shared = !!flags?.commsuni_read && !!reference;
  const remoteRoot = useCommsUniThread(
    reference?.threadType ?? 'MOVIE',
    reference?.threadId ?? '',
    reference?.id ?? '',
    shared,
  );
  const localRevision =
    remoteRoot.data?.localRevision ??
    (localRoot.data?.hasLocalRevision ? localRoot.data : undefined);
  const sharedReplies = shared && !!remoteRoot.data;
  const parent:
    | (CommentView & {
        context?: MyCommentContextDto | null;
        ancestors?: CommentView[];
        review?: CommentView | null;
      })
    | undefined = localRevision
    ? { ...localRevision, context: remoteRoot.data?.thread ?? localRoot.data?.context }
    : shared
      ? remoteRoot.data
        ? {
            ...presentThreadComment(remoteRoot.data),
            context: remoteRoot.data.thread,
            ancestors: [],
          }
        : undefined
      : requestedShared
        ? undefined
        : localRoot.data;
  const parentQ = localRevision && !requestedShared ? localRoot : shared ? remoteRoot : localRoot;
  const waitingForRoot = localRevision
    ? false
    : shared
      ? remoteRoot.isPending
      : requestedShared
        ? flagQuery.isPending
        : localRoot.isPending;
  const feed = useCommentFeed({
    threadType: parent?.threadType ?? reference?.threadType ?? 'MOVIE',
    threadId: parent?.threadId ?? reference?.threadId ?? '',
    sort,
    shared: sharedReplies,
    repliesTo: parent ?? null,
    enabled: !!parent,
  });
  const like = useToggleCommentLike();
  const reviewLike = useToggleExternalReviewLike();
  const actions = useCommentActions({ onEdit: setEditing });

  useEffect(() => {
    setExpanded({});
    setCollapsed(new Set());
    setReplyTarget(null);
    setVisible(new Set());
    setHighlightId(params.highlight ?? null);
    didScrollToHighlight.current = false;
  }, [contextKey, params.highlight]);
  useEffect(() => {
    setExpanded({});
    setCollapsed(new Set());
  }, [sort]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = setTimeout(() => setHighlightId(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightId]);

  const { childrenOf } = useMemo(
    () => buildChildrenMap(feed.items, expanded),
    [feed.items, expanded],
  );
  const topLevel = parent ? (childrenOf.get(parent.id) ?? []) : [];
  useEffect(() => {
    if (!highlightId || highlightId === parent?.id || didScrollToHighlight.current) return;
    const index = topLevel.findIndex(
      (row) => row.id === highlightId || row.shared?.comment.id === highlightId,
    );
    if (index < 0) return;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 });
    didScrollToHighlight.current = true;
  }, [highlightId, parent?.id, topLevel]);

  const loadMore = useCallback(
    async (node: CommentView) => {
      const previous = expanded[node.id];
      if (previous?.loading || previous?.exhausted) return;
      const page = (previous?.page ?? 0) + 1;
      setExpanded((current) => ({
        ...current,
        [node.id]: {
          ...current[node.id],
          items: current[node.id]?.items ?? [],
          loading: true,
          page: page - 1,
        },
      }));
      try {
        let items: CommentView[], cursor: string | null | undefined, exhausted: boolean;
        if (node.shared) {
          const res = await api.get<ConversationPageDto>(
            '/conversations/comments/' + encodeURIComponent(node.shared.comment.id) + '/replies',
            {
              threadType: node.shared.threadType,
              threadId: node.threadId,
              sort,
              ...(previous?.cursor ? { cursor: previous.cursor } : {}),
            },
          );
          items = presentReplies(res.items, node, feed.sources);
          cursor = res.nextCursor;
          exhausted = !res.nextCursor;
        } else {
          const res = await api.get<Paginated<CommentView>>(
            '/comments/' + encodeURIComponent(node.id) + '/replies',
            { page, pageSize: 50, sort, depth: 2 },
          );
          items = res.items;
          exhausted = !res.hasMore;
        }
        if (contextRef.current !== contextKey + ':' + sort) return;
        setExpanded((current) => {
          const merged = new Map((current[node.id]?.items ?? []).map((row) => [row.id, row]));
          items.forEach((row) => merged.set(row.id, row));
          return {
            ...current,
            [node.id]: { items: [...merged.values()], loading: false, page, cursor, exhausted },
          };
        });
      } catch {
        if (contextRef.current !== contextKey + ':' + sort) return;
        setExpanded((current) => ({
          ...current,
          [node.id]: {
            ...current[node.id],
            items: current[node.id]?.items ?? [],
            loading: false,
            page: previous?.page ?? 0,
          },
        }));
        showError({ description: t('comments:failedToLoad') });
      }
    },
    [contextKey, expanded, sort, t, feed.sources],
  );

  const toggleCollapse = useCallback((comment: CommentView) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(comment.id)) next.delete(comment.id);
      else next.add(comment.id);
      return next;
    });
  }, []);
  const patchExpanded = useCallback((id: string, patch: (row: CommentView) => CommentView) => {
    setExpanded((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([key, value]) => [
          key,
          { ...value, items: value.items.map((row) => (row.id === id ? patch(row) : row)) },
        ]),
      ),
    );
  }, []);
  const handleLike = useCallback(
    (comment: CommentView) => {
      if (comment.shared) return; // Provider transport is handled by the common card's like hook.
      if (comment.kind === 'review') {
        reviewLike.mutate({ reviewId: comment.reviewId!, liked: comment.likedByMe });
        return;
      }
      const liked = comment.likedByMe;
      patchExpanded(comment.id, (row) => ({
        ...row,
        likedByMe: !liked,
        likesCount: Math.max(0, row.likesCount + (liked ? -1 : 1)),
      }));
      like.mutate(
        { commentId: comment.id, liked },
        {
          onError: () =>
            patchExpanded(comment.id, (row) => ({
              ...row,
              likedByMe: liked,
              likesCount: Math.max(0, row.likesCount + (liked ? 1 : -1)),
            })),
        },
      );
    },
    [like, reviewLike, patchExpanded],
  );
  const isOwner = useCallback(
    (comment?: CommentView | null) =>
      !!comment &&
      (comment.shared ? comment.shared.comment.actions.delete : comment.author.id === me?.id),
    [me?.id],
  );
  const openAuthor = useCallback((comment: CommentView) => {
    if (!comment.shared && !comment.author.isDeletedUser && comment.author.username)
      router.push(('/user/' + encodeURIComponent(comment.author.username)) as any);
  }, []);
  const handlers: ThreadHandlers = {
    onLike: handleLike,
    onOverflow: (comment) => actions.openOverflow(comment, isOwner(comment)),
    onPressAuthor: openAuthor,
    onReply: (comment) => {
      if (commentCanReply(comment)) setReplyTarget(comment);
    },
    onToggleCollapse: toggleCollapse,
    onLoadMore: loadMore,
    isOwner,
  };
  const target = replyTarget ?? parent;
  const handleCreated = (comment: CommentView) => {
    if (replyTarget && replyTarget.id !== parent?.id) {
      const id = replyTarget.id;
      setExpanded((current) => ({
        ...current,
        [id]: {
          ...current[id],
          items: [
            { ...comment, parentId: id },
            ...(current[id]?.items ?? []).filter((row) => row.id !== comment.id),
          ],
          loading: false,
          page: current[id]?.page ?? 0,
        },
      }));
      setCollapsed((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    } else feed.retain(comment);
  };
  const refresh = () => {
    setExpanded({});
    void parentQ.refetch();
    void feed.refresh();
  };
  const title = parent?.context ? threadContextLabel(parent.context, t) : t('comments:threadTitle');
  const header = parent ? (
    <View style={{ paddingBottom: spacing.sm }}>
      {parent.review ? (
        <CommentCard
          comment={parent.review}
          isOwner={false}
          onLike={handleLike}
          onOverflow={(comment) => actions.openOverflow(comment, false)}
        />
      ) : null}
      {(parent.ancestors ?? []).map((comment) => (
        <View key={comment.id} style={{ opacity: 0.75 }}>
          <NodeContent comment={comment} depth={0} collapsed={false} handlers={handlers} />
        </View>
      ))}
      <NodeContent
        key={parent.id}
        comment={parent}
        depth={0}
        collapsed={false}
        handlers={handlers}
        highlighted={parent.id === highlightId}
      />
      <View style={{ paddingTop: spacing.sm, paddingLeft: spacing.xs }}>
        <SortBar
          attribution={shared}
          sort={sort}
          onChange={setSort}
          total={feed.total ?? parent.repliesCount}
          totalLabel={(count) =>
            count +
            ' ' +
            t(count === 1 ? 'comments:replySingular' : 'comments:replyPlural', { count })
          }
        />
      </View>
    </View>
  ) : null;
  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.background }}
      behavior="padding"
    >
      <Screen style={{ flex: 1 }}>
        <Header
          title={title}
          showBack
          right={
            parent ? (
              <Pressable
                onPress={() =>
                  router.push(
                    ('/comments?type=' +
                      parent.threadType +
                      '&threadId=' +
                      encodeURIComponent(parent.threadId)) as any,
                  )
                }
                hitSlop={spacing.sm}
                accessibilityRole="button"
              >
                <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
                  {t('comments:viewFullThread')}
                </T>
              </Pressable>
            ) : undefined
          }
        />
        <View style={[feedColumn.root, { flex: 1 }]}>
          {waitingForRoot ? (
            <Spinner />
          ) : parentQ.isError || !parent ? (
            <EmptyState title={t('comments:failedToLoad')} icon="alert-circle-outline" />
          ) : (
            <FlatList
              ref={listRef}
              style={{ flex: 1 }}
              data={topLevel}
              keyExtractor={(comment) => comment.renderKey ?? comment.id}
              keyboardShouldPersistTaps="handled"
              onViewableItemsChanged={viewable}
              viewabilityConfig={viewabilityConfig}
              removeClippedSubviews={false}
              initialNumToRender={8}
              maxToRenderPerBatch={8}
              windowSize={7}
              onScrollToIndexFailed={({ averageItemLength, index }) =>
                listRef.current?.scrollToOffset({
                  offset: (averageItemLength || 120) * index,
                  animated: true,
                })
              }
              contentContainerStyle={{
                paddingHorizontal: spacing.sm,
                paddingBottom: spacing.xl,
                flexGrow: 1,
              }}
              refreshing={feed.isRefetching}
              onRefresh={refresh}
              ListHeaderComponent={header}
              ListEmptyComponent={
                feed.isLoading ? (
                  <Spinner />
                ) : feed.isError ? (
                  <Pressable onPress={refresh}>
                    <T>
                      {t('comments:failedToLoad')} · {t('comments:retry')}
                    </T>
                  </Pressable>
                ) : (
                  <EmptyState
                    title={t('comments:noReplies')}
                    subtitle={t('comments:beFirstToReply')}
                    icon="chatbubble-outline"
                  />
                )
              }
              ListFooterComponent={
                feed.isFetchNextPageError ? (
                  <Pressable onPress={refresh}>
                    <T>{t('comments:retry')}</T>
                  </Pressable>
                ) : feed.isFetchingNextPage ? (
                  <Spinner />
                ) : topLevel.length && !feed.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (feed.hasNextPage && !feed.isFetchingNextPage && !feed.isFetchNextPageError)
                  void feed.fetchNextPage();
              }}
              onEndReachedThreshold={0.4}
              renderItem={({ item }) => (
                <ThreadNode
                  node={item}
                  depth={1}
                  childrenOf={childrenOf}
                  collapsed={collapsed}
                  expanded={expanded}
                  handlers={handlers}
                  highlightId={highlightId}
                  visibleIds={visible}
                />
              )}
            />
          )}
        </View>
        {parent && target && commentCanReply(target) ? (
          <CommentComposer
            threadType={parent.threadType}
            threadId={parent.threadId}
            {...commentReplyTarget(target)}
            placeholder={t('comments:addReply')}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            onCreated={handleCreated}
            onSent={() => setReplyTarget(null)}
          />
        ) : null}
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
        <CommentActions {...actions.dialog} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
