import React, { useState } from 'react';
import { FlatList, KeyboardAvoidingView, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { SortBar } from '../../components/comments/SortBar';
import { CommentCard } from '../../components/comments/CommentCard';
import { CommentComposer } from '../../components/comments/CommentComposer';
import { CommentEditDialog } from '../../components/comments/CommentEditDialog';
import { useCommentActions } from '../../components/comments/useCommentActions';
import { feedColumn } from '../../components/comments/layout';
import {
  useComment,
  useCommentReplies,
  useMe,
  useToggleCommentLike,
  type CommentSortMode,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';

export default function CommentThreadScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const parentQ = useComment(id, true);
  const parent = parentQ.data;

  const replies = useCommentReplies(id, sort, { polling: true });
  const like = useToggleCommentLike();
  const { openOverflow } = useCommentActions({ onEdit: setEditing });

  const replyItems: CommentDto[] = replies.data?.pages.flatMap((p) => p.items) ?? [];
  const repliesTotal = replies.data?.pages[0]?.total ?? parent?.repliesCount ?? 0;
  const isFetchingNextPage = replies.isFetchingNextPage;

  const isOwner = (c?: CommentDto | null) => !!c && c.author?.id === currentUserId;
  const openAuthor = (c: CommentDto) => c.author?.username && router.push(`/user/${encodeURIComponent(c.author.username)}` as any);

  const renderReply = ({ item }: { item: CommentDto }) => (
    <CommentCard
      comment={item}
      isOwner={isOwner(item)}
      onLike={(c) => like.mutate({ commentId: c.id, liked: c.likedByMe })}
      onOverflow={(c) => openOverflow(c, isOwner(c))}
      onPressAuthor={openAuthor}
      compact
    />
  );

  const ListHeader = parent ? (
    <View>
      <CommentCard
        comment={parent}
        isOwner={isOwner(parent)}
        onLike={(c) => like.mutate({ commentId: c.id, liked: c.likedByMe })}
        onOverflow={(c) => openOverflow(c, isOwner(parent))}
        onPressAuthor={openAuthor}
      />
      <View style={{ paddingTop: spacing.md }}>
        <SortBar
          sort={sort}
          onChange={setSort}
          total={repliesTotal}
          totalLabel={(n) =>
            `${n} ${t(n === 1 ? 'comments:replySingular' : 'comments:replyPlural', { count: n })}`
          }
        />
      </View>
      <T variant="caption" style={{ fontWeight: '700', paddingTop: spacing.sm }}>
        {t('comments:repliesTitle')}
      </T>
    </View>
  ) : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens.background }} behavior="padding">
      <Screen style={{ flex: 1 }}>
        <Header title={t('comments:threadTitle')} showBack />

        {/* Centered column (same max-width as the main feed). */}
        <View style={[feedColumn.root, { flex: 1 }]}>
          {parentQ.isLoading ? (
            <Spinner />
          ) : parentQ.isError || !parent ? (
            <EmptyState title={t('comments:failedToLoad')} icon="alert-circle-outline" />
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={replyItems}
              keyExtractor={(i) => i.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 }}
              ListHeaderComponent={ListHeader}
              ListEmptyComponent={
                replies.isLoading ? null : (
                  <EmptyState
                    title={t('comments:noReplies')}
                    subtitle={t('comments:beFirstToReply')}
                    icon="chatbubble-outline"
                  />
                )
              }
              ListFooterComponent={
                isFetchingNextPage ? (
                  <View style={{ paddingVertical: spacing.md, alignItems: 'center' }}>
                    <T variant="micro" muted>
                      {t('comments:loadingMore')}
                    </T>
                  </View>
                ) : replyItems.length > 0 && !replies.hasNextPage ? (
                  <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>
                    {t('comments:reachedEnd')}
                  </T>
                ) : null
              }
              onEndReached={() => {
                if (replies.hasNextPage && !isFetchingNextPage && !replies.isError)
                  replies.fetchNextPage().catch(() => showError({ description: t('comments:failedToLoad') }));
              }}
              onEndReachedThreshold={0.4}
              ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
              renderItem={renderReply}
            />
          )}
        </View>

        {parent ? (
          <CommentComposer
            threadType={parent.threadType}
            threadId={parent.threadId}
            parentId={parent.id}
            placeholder={t('comments:addReply')}
          />
        ) : null}
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
      </Screen>
    </KeyboardAvoidingView>
  );
}
