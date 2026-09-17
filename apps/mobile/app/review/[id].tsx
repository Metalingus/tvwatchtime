import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { TranslatableContent } from '../../components/comments/TranslatableContent';
import { router, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { formatDateTime, type CommentDto, type Paginated } from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { EmptyState, Screen, Spinner, T } from '../../components/primitives';
import { SortBar } from '../../components/comments/SortBar';
import { ThreadNode, type ThreadHandlers } from '../../components/comments/ThreadNode';
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
import {
  useExternalReview,
  useExternalReviewReplies,
  useMe,
  useToggleCommentLike,
  useToggleExternalReviewLike,
  type CommentSortMode,
} from '../../api/hooks';
import { api } from '../../api/client';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { showError } from '../../lib/dialog';
import { TMDB_BRAND_COLOR } from '../../components/comments/provider-theme';

const AVATAR = 44;

/**
 * TMDB review thread page: the review acts exactly like a parent comment — header card
 * (badge links to the TMDB source), likeable, with the full reply tree and a composer
 * anchored to the review (replies to replies nest via parentId like everywhere else).
 */
export default function ReviewThreadScreen() {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'common', 'groups']);
  const params = useLocalSearchParams<{ id: string }>();
  const id = params.id;
  const qc = useQueryClient();

  const [sort, setSort] = useState<CommentSortMode>('LATEST');
  const [editing, setEditing] = useState<CommentDto | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<Record<string, ExpandedNode>>({});
  const [replyTarget, setReplyTarget] = useState<CommentDto | null>(null);

  const { data: me } = useMe();
  const currentUserId = me?.id;
  const reviewQ = useExternalReview(id, true);
  const review = reviewQ.data;
  const repliesQ = useExternalReviewReplies(id, true);
  const like = useToggleCommentLike();
  const reviewLike = useToggleExternalReviewLike();
  const actions = useCommentActions({ onEdit: setEditing });
  const { openOverflow } = actions;

  const items = useMemo(() => repliesQ.data ?? [], [repliesQ.data]);
  const topLevel = useMemo(() => items.filter((c) => !c.parentId), [items]);
  const { childrenOf, byId } = useMemo(() => buildChildrenMap(items, expanded), [items, expanded]);
  const repliesTotal = review?.repliesCount ?? topLevel.length;

  const toggleCollapse = useCallback((c: CommentDto) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  }, []);

  const loadMore = useCallback(
    async (node: CommentDto) => {
      const nextPage = (expanded[node.id]?.page ?? 0) + 1;
      setExpanded((prev) => ({
        ...prev,
        [node.id]: {
          items: prev[node.id]?.items ?? [],
          loading: true,
          page: prev[node.id]?.page ?? 0,
        },
      }));
      try {
        const res = await api.get<Paginated<CommentDto>>(`/comments/${node.id}/replies`, {
          page: nextPage,
          pageSize: 50,
          sort,
          depth: 2,
        });
        setExpanded((prev) => ({
          ...prev,
          [node.id]: {
            items: [...(prev[node.id]?.items ?? []), ...res.items],
            loading: false,
            page: nextPage,
          },
        }));
      } catch {
        showError({ description: t('comments:failedToLoad') });
      }
    },
    [expanded, sort, t],
  );

  const handleLikeHeader = useCallback(() => {
    if (!review) return;
    const wasLiked = review.likedByMe;
    // Optimistic header patch.
    qc.setQueryData(['externalReview', id], (old: any) =>
      old
        ? {
            ...old,
            likedByMe: !wasLiked,
            likesCount: Math.max(0, (old.likesCount ?? 0) + (wasLiked ? -1 : 1)),
          }
        : old,
    );
    reviewLike.mutate(
      { reviewId: review.id, liked: wasLiked },
      {
        onError: () =>
          qc.setQueryData(['externalReview', id], (old: any) =>
            old
              ? {
                  ...old,
                  likedByMe: wasLiked,
                  likesCount: Math.max(0, (old.likesCount ?? 0) + (wasLiked ? 1 : -1)),
                }
              : old,
          ),
      },
    );
  }, [review, reviewLike, qc, id]);

  const handleLike = useCallback(
    (c: CommentDto) => like.mutate({ commentId: c.id, liked: c.likedByMe }),
    [like],
  );

  const handleSent = useCallback(async () => {
    const target = replyTarget;
    setReplyTarget(null);
    qc.invalidateQueries({ queryKey: ['externalReviewReplies', id] });
    qc.invalidateQueries({ queryKey: ['externalReview', id] });
    if (target) {
      const fresh = byId.get(target.id) ?? target;
      await loadMore(fresh);
    }
  }, [replyTarget, id, byId, loadMore, qc]);

  const isOwner = useCallback(
    (c?: CommentDto | null) => !!c && c.author?.id === currentUserId,
    [currentUserId],
  );
  const openAuthor = useCallback(
    (c: CommentDto) =>
      c.author?.username && router.push(`/user/${encodeURIComponent(c.author.username)}` as any),
    [],
  );

  const handlers: ThreadHandlers = useMemo(
    () => ({
      onLike: handleLike,
      onOverflow: (c: CommentDto) => openOverflow(c, isOwner(c)),
      onPressAuthor: openAuthor,
      onReply: (c: CommentDto) => setReplyTarget(c),
      onToggleCollapse: toggleCollapse,
      onLoadMore: loadMore,
      isOwner,
    }),
    [handleLike, openOverflow, isOwner, openAuthor, toggleCollapse, loadMore],
  );

  const openSource = () => review?.url && Linking.openURL(review.url).catch(() => undefined);

  const ListHeader = review ? (
    <View style={styles.headerWrap}>
      <View style={[styles.reviewCard, { backgroundColor: tokens.cardBackground }]}>
        <View style={styles.headerRow}>
          {review.avatarUrl ? (
            <Image source={{ uri: review.avatarUrl }} style={styles.avatar} contentFit="cover" />
          ) : (
            <Ionicons name="person-circle" size={AVATAR} color={tokens.textMuted} />
          )}
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <View style={styles.nameRow}>
              <T variant="body" numberOfLines={1} style={{ fontWeight: '700', flexShrink: 1 }}>
                {review.author}
              </T>
              <Pressable
                onPress={openSource}
                hitSlop={6}
                accessibilityRole="link"
                accessibilityLabel="TMDB"
                style={[styles.badge, { backgroundColor: TMDB_BRAND_COLOR }]}
              >
                <T variant="micro" style={[styles.badgeText, { color: tokens.mediaText }]}>
                  TMDB
                </T>
                <Ionicons name="open-outline" size={10} color={tokens.mediaText} />
              </Pressable>
            </View>
            <View style={styles.metaRow}>
              {review.rating != null && (
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="star" size={12} color={tokens.orange} />
                  <T variant="micro" style={{ color: tokens.orange, fontWeight: '700' }}>
                    {` ${review.rating}/10`}
                  </T>
                </View>
              )}
              <T variant="micro" muted>
                {formatDateTime(String(review.createdAt), resolvedLocale)}
              </T>
            </View>
          </View>
        </View>
        <View style={{ marginTop: spacing.sm }}>
          <TranslatableContent
            id={review.id}
            kind="review"
            content={
              review.translatableContent ?? {
                original: review.content,
                format: 'html',
                eligible: false,
              }
            }
          />
        </View>
        <View style={styles.headerActions}>
          <Pressable
            onPress={handleLikeHeader}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:like')}
          >
            <Ionicons
              name={review.likedByMe ? 'heart' : 'heart-outline'}
              size={18}
              color={review.likedByMe ? tokens.favorite : tokens.textMuted}
            />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {review.likesCount}
            </T>
          </Pressable>
          <Pressable
            onPress={() => setReplyTarget(null)}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:reply')}
          >
            <Ionicons name="chatbubble-outline" size={18} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {repliesTotal > 0
                ? repliesTotal === 1
                  ? t('common:replySingular', { count: 1 })
                  : t('common:replyPlural', { count: repliesTotal })
                : t('comments:reply')}
            </T>
          </Pressable>
        </View>
      </View>
      <View style={{ paddingTop: spacing.sm, paddingLeft: spacing.xs }}>
        <SortBar
          sort={sort}
          onChange={setSort}
          total={repliesTotal}
          totalLabel={(n) =>
            `${n} ${t(n === 1 ? 'comments:replySingular' : 'comments:replyPlural', { count: n })}`
          }
        />
      </View>
    </View>
  ) : null;

  const renderNode = ({ item }: { item: CommentDto }) => (
    <ThreadNode
      node={item}
      depth={1}
      childrenOf={childrenOf}
      collapsed={collapsed}
      expanded={expanded}
      handlers={handlers}
      highlightId={null}
    />
  );

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: tokens.background }}
      behavior="padding"
    >
      <Screen style={{ flex: 1 }}>
        <Header
          title={
            review?.context
              ? threadContextLabel(review.context, t) || t('comments:threadTitle')
              : t('comments:threadTitle')
          }
          showBack
        />
        <View style={[feedColumn.root, { flex: 1 }]}>
          {reviewQ.isLoading ? (
            <Spinner />
          ) : reviewQ.isError || !review ? (
            <EmptyState title={t('comments:failedToLoad')} icon="alert-circle-outline" />
          ) : (
            <FlatList
              style={{ flex: 1 }}
              data={topLevel}
              keyExtractor={(c) => c.id}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                paddingHorizontal: spacing.sm,
                paddingBottom: spacing.xl,
                flexGrow: 1,
              }}
              ListHeaderComponent={ListHeader}
              ListEmptyComponent={
                repliesQ.isLoading ? null : (
                  <EmptyState
                    title={t('comments:noReplies')}
                    subtitle={t('comments:beFirstToReply')}
                    icon="chatbubble-outline"
                  />
                )
              }
              renderItem={renderNode}
            />
          )}
        </View>

        {review ? (
          <CommentComposer
            threadType={review.threadType}
            threadId={review.threadId}
            // Reply to the review root → externalReviewId; reply to a comment → parentId.
            parentId={replyTarget?.id ?? null}
            reviewTarget={replyTarget ? null : (review as any)}
            placeholder={t('comments:addReply')}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            onSent={handleSent}
          />
        ) : null}
        <CommentEditDialog comment={editing} onClose={() => setEditing(null)} />
        <CommentActions {...actions.dialog} />
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  headerWrap: { paddingBottom: spacing.sm },
  reviewCard: { borderRadius: radius.lg, padding: spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center' },
  avatar: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { fontWeight: '900', letterSpacing: 0.5, fontSize: 9 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
});
