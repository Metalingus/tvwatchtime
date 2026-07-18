import React, { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Pressable, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { Header } from '../Header';
import { EmptyState, Screen, Spinner, T } from '../primitives';
import { SortBar } from './SortBar';
import { CommentCard } from './CommentCard';
import { CommentComposer } from './CommentComposer';
import { CommentEditDialog } from './CommentEditDialog';
import { useCommentActions } from './useCommentActions';
import { feedColumn } from './layout';
import { useCommentsFeed, useMe, useToggleCommentLike, type CommentSortMode } from '../../api/hooks';
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
  const { t } = useTranslation(['comments', 'common']);

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const feed = useCommentsFeed({ threadType, threadId, sort, polling: true });
  const like = useToggleCommentLike();
  const { openOverflow } = useCommentActions({ onEdit: setEditing });

  const items: CommentDto[] = feed.data?.pages.flatMap((p) => p.items) ?? [];
  const total = feed.data?.pages[0]?.total ?? 0;
  const isFetchingNextPage = feed.isFetchingNextPage;

  const openThread = (c: CommentDto) => router.push(`/comment/${c.id}` as any);
  const openAuthor = (c: CommentDto) => c.author?.username && router.push(`/user/${encodeURIComponent(c.author.username)}` as any);

  const renderItem = ({ item }: { item: CommentDto }) => (
    <CommentCard
      comment={item}
      isOwner={item.author?.id === currentUserId}
      onLike={(c) => like.mutate({ commentId: c.id, liked: c.likedByMe })}
      onOpenThread={openThread}
      onOverflow={(c) => openOverflow(c, c.author?.id === currentUserId)}
      onPressAuthor={openAuthor}
      showReplyAction
      interactive
    />
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens.background }} behavior="padding">
      <Screen style={{ flex: 1 }}>
        <Header title={title} showBack />

        {/* Centered feed column: full-width on mobile, capped + centered on desktop/tablet. */}
        <View style={[feedColumn.root, { flex: 1 }]}>
          <View style={{ paddingHorizontal: spacing.lg }}>
            <SortBar
              sort={sort}
              onChange={setSort}
              total={total}
              totalLabel={(n) =>
                `${n} ${t(n === 1 ? 'comments:commentSingular' : 'comments:commentPlural', { count: n })}`
              }
            />
          </View>

          {feed.isLoading ? (
            <Spinner />
          ) : feed.isError ? (
            <View style={{ padding: spacing.xl, alignItems: 'center' }}>
              <T variant="body" muted style={{ marginBottom: spacing.md }}>
                {t('comments:failedToLoad')}
              </T>
              <Pressable onPress={() => feed.refetch()} hitSlop={8}>
                <T variant="caption" style={{ color: tokens.primary, fontWeight: '700' }}>
                  {t('comments:retry')}
                </T>
              </Pressable>
            </View>
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={items}
              keyExtractor={(i) => i.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 }}
              ListEmptyComponent={
                <EmptyState
                  title={t('comments:noComments')}
                  subtitle={t('comments:beFirst')}
                  icon="chatbubble-ellipses-outline"
                />
              }
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                    <T variant="micro" muted>
                      {t('comments:loadingMore')}
                    </T>
                  </View>
                ) : items.length > 0 && !feed.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (feed.hasNextPage && !isFetchingNextPage && !feed.isError)
                  feed.fetchNextPage().catch(() => showError({ description: t('comments:failedToLoad') }));
              }}
              onEndReachedThreshold={0.4}
              ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
              renderItem={renderItem}
            />
          )}
        </View>

        <CommentComposer
          threadType={threadType}
          threadId={threadId}
          parentId={null}
          placeholder={t('comments:addComment')}
        />
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
