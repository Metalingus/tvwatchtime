import React, { useRef, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, View, type ViewToken } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentView as CommentDto } from '../../api/commsuni-presentation';
import { commentThreadUrl } from '../../api/commsuni-presentation';
import { useCommentFeed } from '../../api/commsuni';
import { CommentActions } from './CommentActions';
import { activateMediaKeys } from './media-layout';
import { useFeatureFlags } from '../../api/hooks';
import { Header } from '../Header';
import { EmptyState, Screen, Spinner, T } from '../primitives';
import { SortBar } from './SortBar';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import { CommentEditDialog } from './CommentEditDialog';
import { useCommentActions } from './useCommentActions';
import { feedColumn } from './layout';
import { threadContextLabel } from './thread-utils';
import {
  useMe,
  useToggleCommentLike,
  useToggleExternalReviewLike,
  type CommentSortMode,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

/** Full comment feed screen body for any thread (media or community group). */
export function CommentsFeed({
  threadType,
  threadId,
  title,
}: {
  threadType: string;
  threadId: string;
  title: string;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common', 'groups']);

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const flagQuery = useFeatureFlags();
  const flags = flagQuery.data;
  const shared = !!flags?.commsuni_read && ['SHOW', 'MOVIE', 'EPISODE'].includes(threadType);
  const feed = useCommentFeed({
    threadType,
    threadId,
    sort,
    shared,
    enabled: !flagQuery.isPending,
  });
  const [visible, setVisible] = useState<Set<string>>(new Set());
  const viewabilityConfig = useRef({ viewAreaCoveragePercentThreshold: 1 }).current;
  const viewable = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) =>
    setVisible((previous) =>
      activateMediaKeys(
        previous,
        viewableItems.map((item) => String(item.key)),
      ),
    ),
  ).current;
  const like = useToggleCommentLike();
  const reviewLike = useToggleExternalReviewLike();
  const actions = useCommentActions({ onEdit: setEditing });

  const items = feed.items;
  const total = feed.total;
  const isFetchingNextPage = feed.isFetchingNextPage;
  // Header names the thread (show/movie/episode title, localized group name) once the
  // first page arrives; the caller-provided title is the fallback.
  const threadCtx = feed.thread;
  const headerTitle = threadCtx ? threadContextLabel(threadCtx, t) || title : title;

  // Reviews are first-class thread roots: they open their own thread page and like
  // through the review endpoint; everything else behaves like a normal comment card.
  const openThread = (c: CommentDto) => router.push(commentThreadUrl(c) as any);
  const handleLike = (c: CommentDto) =>
    c.kind === 'review'
      ? reviewLike.mutate({ reviewId: c.reviewId!, liked: c.likedByMe })
      : like.mutate({ commentId: c.id, liked: c.likedByMe });
  const openAuthor = (c: CommentDto) =>
    !c.shared &&
    c.kind !== 'review' &&
    c.author?.username &&
    router.push(`/user/${encodeURIComponent(c.author.username)}` as any);

  const renderItem = ({ item }: { item: CommentDto }) => (
    <CommentCard
      comment={item}
      visible={visible.has(item.renderKey ?? item.id)}
      isOwner={item.shared ? item.shared.comment.actions.delete : item.author?.id === currentUserId}
      onLike={handleLike}
      onOpenThread={openThread}
      onOverflow={(c) => actions.openOverflow(c, c.author?.id === currentUserId)}
      onPressAuthor={openAuthor}
      showReplyAction
      interactive
    />
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.background }}
      behavior="padding"
    >
      <Screen style={{ flex: 1 }}>
        <Header title={headerTitle} showBack />

        {/* Centered feed column: full-width on mobile, capped + centered on desktop/tablet. */}
        <View style={[feedColumn.root, { flex: 1 }]}>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <SortBar
              attribution={shared}
              sort={sort}
              onChange={setSort}
              total={total}
              totalLabel={(n) =>
                `${n} ${t(n === 1 ? 'comments:commentSingular' : 'comments:commentPlural', { count: n })}`
              }
            />
          </View>

          {feed.upstream ? (
            <T variant="caption" muted style={{ padding: spacing.md }}>
              {t(
                feed.upstream === 'unmapped'
                  ? 'comments:commsuni.unmapped'
                  : feed.upstream === 'throttled'
                    ? 'comments:commsuni.throttled'
                    : 'comments:commsuni.unavailable',
              )}
            </T>
          ) : null}
          {flagQuery.isPending || feed.isLoading ? (
            <Spinner />
          ) : feed.isError && !items.length ? (
            <View style={{ padding: spacing.xl, alignItems: 'center' }}>
              <T variant="body" muted style={{ marginBottom: spacing.md }}>
                {t('comments:failedToLoad')}
              </T>
              <Pressable
                onPress={() => {
                  void feed.refresh();
                }}
                hitSlop={8}
              >
                <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
                  {t('comments:retry')}
                </T>
              </Pressable>
            </View>
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={items}
              keyExtractor={(i) => i.renderKey ?? i.id}
              onViewableItemsChanged={viewable}
              viewabilityConfig={viewabilityConfig}
              removeClippedSubviews={false}
              initialNumToRender={10}
              maxToRenderPerBatch={10}
              windowSize={7}
              refreshing={feed.isRefetching}
              onRefresh={() => {
                void feed.refresh();
              }}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: spacing.lg,
                paddingBottom: spacing.xl,
                flexGrow: 1,
              }}
              ListEmptyComponent={
                <EmptyState
                  title={t(feed.hasNextPage ? 'comments:loadingMore' : 'comments:noComments')}
                  subtitle={feed.hasNextPage ? undefined : t('comments:beFirst')}
                  icon="chatbubble-ellipses-outline"
                />
              }
              ListFooterComponent={
                feed.isFetchNextPageError ? (
                  <Pressable
                    onPress={() => {
                      void feed.refresh();
                    }}
                  >
                    <T>{t('comments:retry')}</T>
                  </Pressable>
                ) : isFetchingNextPage ? (
                  <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                    <T variant="micro" muted>
                      {t('comments:loadingMore')}
                    </T>
                  </View>
                ) : feed.hasNextPage ? (
                  <Pressable
                    onPress={() => {
                      void feed.fetchNextPage();
                    }}
                  >
                    <T variant="caption" style={{ color: tokens.primary, textAlign: 'center' }}>
                      {t('comments:loadMore')}
                    </T>
                  </Pressable>
                ) : items.length > 0 && !feed.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (
                  feed.hasNextPage &&
                  !isFetchingNextPage &&
                  !feed.isError &&
                  !feed.isFetchNextPageError
                )
                  feed
                    .fetchNextPage()
                    .catch(() => showError({ description: t('comments:failedToLoad') }));
              }}
              onEndReachedThreshold={0.4}
              ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
              renderItem={renderItem}
            />
          )}
        </View>

        <CommentComposer
          threadType={threadType}
          threadId={threadCtx?.threadId ?? threadId}
          onCreated={feed.retain}
          parentId={null}
          placeholder={t('comments:addComment')}
        />
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
        <CommentActions {...actions.dialog} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
