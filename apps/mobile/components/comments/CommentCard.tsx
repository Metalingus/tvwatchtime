import { commsUniOperationMessage } from '../../api/commsuni-operation';
import React, { useState } from 'react';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type {
  CommentDto,
  CommentListRefDto,
  CommentMediaRefDto,
  CommsUniOrigin,
} from '@tvwatch/shared';
import { formatDateTime } from '@tvwatch/shared';
import { PosterImage, T } from '../primitives';
import { CommentMedia } from './CommentMedia';
import { ProfileAvatar } from '../ProfileAvatar';
import { CommentSourceBadge } from './CommentSourceBadge';
import { authorDisplayName, formatRelativeShort, THREAD_CONTENT_INDENT } from './thread-utils';
import { useSharedCommentLike } from '../../api/commsuni';
import { commentCanReply, type CommentView } from '../../api/commsuni-presentation';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { TranslatableContent } from './TranslatableContent';
import { TMDB_BRAND_COLOR } from './provider-theme';

const AVATAR = 40;
const AVATAR_COMPACT = 32;

export interface CommentCardProps {
  comment: CommentView;
  isOwner: boolean;
  onLike: (c: CommentDto) => void;
  /** Open the dedicated thread screen (feed cards). */
  onOpenThread?: (c: CommentDto) => void;
  /** Show the overflow action sheet (report / block / edit / delete). */
  onOverflow: (c: CommentDto) => void;
  /** Open the author's profile (avatar tap). Does not open the thread. */
  onPressAuthor?: (c: CommentDto) => void;
  /** Show the reply count + icon that opens the thread. */
  showReplyAction?: boolean;
  /** Whole card is tappable to open the thread. */
  interactive?: boolean;
  /** Compact avatar (used for replies). */
  compact?: boolean;
  sourceOrigin?: CommsUniOrigin;
  visible?: boolean;
  threadDepth?: number;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onReply?: (comment: CommentView) => void;
}

/** Stop a press from bubbling into the card's open-thread handler (web). */
function stop(e: any) {
  e?.stopPropagation?.();
}

export function CommentCard({
  comment,
  onLike,
  onOpenThread,
  onOverflow,
  onPressAuthor,
  showReplyAction = false,
  interactive = false,
  compact = false,
  sourceOrigin = comment.sourceOrigin,
  visible = true,
  threadDepth,
  collapsed,
  onToggleCollapse,
  onReply,
}: CommentCardProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const tombstone = comment.deletedByUser;
  const sharedLike = useSharedCommentLike(comment);
  const isThread = threadDepth != null;
  const contentIndent = (threadDepth ?? 0) > 0 ? THREAD_CONTENT_INDENT : 0;
  const liked = comment.shared ? sharedLike.liked : comment.likedByMe;
  const likesCount = comment.shared ? sharedLike.count : comment.likesCount;
  const canLike =
    !tombstone &&
    (comment.shared
      ? comment.shared.comment.actions.like && !sharedLike.busy
      : !(comment.commsUniState && !comment.commsUniCommentId));
  const avatar = compact ? AVATAR_COMPACT : AVATAR;
  const author = comment.author;
  // Spoiler censoring: body + attachments stay hidden until THIS user taps to reveal
  // (per-card, per-session — never persisted).
  const [revealed, setRevealed] = useState(false);
  const censored = comment.isSpoiler && !tombstone && !revealed;

  const openThread = () => onOpenThread?.(comment);
  const openMedia = (media: CommentMediaRefDto) =>
    router.push(`/${media.mediaType === 'SHOW' ? 'show' : 'movie'}/${media.mediaId}` as any);
  const openList = (list: CommentListRefDto) => router.push(`/list/${list.id}` as any);
  const isReview = comment.kind === 'review';
  const openReviewSource = () =>
    comment.reviewUrl && Linking.openURL(comment.reviewUrl).catch(() => undefined);

  if (tombstone) {
    return (
      <View testID="comment-tombstone" style={{ padding: spacing.sm }}>
        <T muted>{t('comments:deleted')}</T>
        {showReplyAction && comment.repliesCount > 0 && onOpenThread ? (
          <Pressable
            onPress={openThread}
            accessibilityRole="button"
            style={{ paddingTop: spacing.xs }}
          >
            <T variant="caption" style={{ color: tokens.primary }}>
              {t('comments:viewReplies', { count: comment.repliesCount })}
            </T>
          </Pressable>
        ) : null}
        {onToggleCollapse ? (
          <Pressable onPress={onToggleCollapse} accessibilityRole="button">
            <T variant="caption" style={{ color: tokens.primary }}>
              {t(collapsed ? 'comments:expandThread' : 'comments:collapseThread')}
            </T>
          </Pressable>
        ) : null}
      </View>
    );
  }

  const overflow = !isReview ? (
    <Pressable
      onPress={(event) => {
        stop(event);
        onOverflow(comment);
      }}
      hitSlop={10}
      style={styles.overflowBtn}
      accessibilityRole="button"
      accessibilityLabel={t('common:moreOptions')}
    >
      <Ionicons name="ellipsis-horizontal" size={20} color={tokens.textMuted} />
    </Pressable>
  ) : null;
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: tokens.cardBackground },
        compact && styles.cardCompact,
        isThread && { padding: 0, backgroundColor: 'transparent', borderRadius: 0 },
        interactive && pressed && styles.cardPressed,
      ]}
      onPress={interactive ? openThread : undefined}
      disabled={!interactive}
    >
      <View style={[styles.header, { zIndex: 1 }]}>
        <View testID="comment-avatar" style={{ flexShrink: 0, zIndex: 1 }}>
          <Pressable
            onPress={(event) => {
              stop(event);
              if (isReview) openReviewSource();
              else if (!comment.shared && !author?.isDeletedUser) onPressAuthor?.(comment);
            }}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={authorDisplayName(author, t)}
          >
            <ProfileAvatar uri={author?.isDeletedUser ? null : author?.avatarUrl} size={avatar} />
          </Pressable>
          {!isReview ? (
            <CommentSourceBadge
              local={!sourceOrigin}
              origin={
                sourceOrigin ?? {
                  slug: 'tvwatch',
                  displayName: t('common:appName'),
                  kind: 'partner',
                  iconUrl: null,
                }
              }
            />
          ) : null}
        </View>
        <View
          style={[
            styles.nameCol,
            isThread && { marginLeft: spacing.sm, flexDirection: 'row', alignItems: 'center' },
          ]}
        >
          <View style={[styles.nameRow, isThread && { flexShrink: 1 }]}>
            <T
              variant="caption"
              numberOfLines={1}
              style={{ fontWeight: '700', color: tokens.textPrimary, flexShrink: 1 }}
            >
              {authorDisplayName(author, t)}
            </T>
            {isReview ? (
              <Pressable
                onPress={(event) => {
                  stop(event);
                  openReviewSource();
                }}
                hitSlop={6}
                accessibilityRole="link"
                accessibilityLabel="TMDB"
                style={[styles.reviewBadge, { backgroundColor: TMDB_BRAND_COLOR }]}
              >
                <T variant="micro" style={[styles.reviewBadgeText, { color: tokens.mediaText }]}>
                  TMDB
                </T>
                <Ionicons name="open-outline" size={10} color={tokens.mediaText} />
              </Pressable>
            ) : null}
            {comment.isEdited && !tombstone ? (
              <T variant="micro" muted style={{ marginLeft: spacing.xs }}>
                · {t('comments:edited')}
              </T>
            ) : null}
          </View>
          {comment.createdAt ? (
            <T
              variant="micro"
              muted
              numberOfLines={1}
              style={{
                marginTop: isThread ? 0 : 2,
                marginLeft: isThread ? spacing.xs : 0,
                flexShrink: 1,
              }}
            >
              {isThread
                ? formatRelativeShort(comment.createdAt, t, resolvedLocale)
                : formatDateTime(comment.createdAt, resolvedLocale)}
            </T>
          ) : null}
        </View>
        {overflow}
      </View>

      <View style={{ marginLeft: contentIndent }}>
        {comment.shared?.comment.inReplyToCommentId &&
        comment.shared.comment.inReplyToCommentId !== comment.shared.comment.parentCommentId ? (
          <Pressable
            accessibilityRole="link"
            style={{ marginBottom: spacing.xs }}
            onPress={(event) => {
              stop(event);
              const shared = comment.shared!;
              router.push(
                ('/comment/' +
                  encodeURIComponent(shared.comment.inReplyToCommentId!) +
                  '?source=commsuni&threadType=' +
                  shared.threadType +
                  '&threadId=' +
                  encodeURIComponent(shared.threadId)) as any,
              );
            }}
          >
            <T variant="caption" style={{ color: tokens.primary }}>
              {t('comments:commsuni.replyTarget')}
            </T>
          </Pressable>
        ) : null}
        {/* Spoiler cover: replaces body + all attachments until the reader taps to reveal */}
        {censored ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              setRevealed(true);
            }}
            style={[styles.spoilerCover, { backgroundColor: tokens.surfaceElevated }]}
            accessibilityRole="button"
            accessibilityLabel={t('comments:viewSpoiler')}
          >
            <Ionicons name="eye-off-outline" size={18} color={tokens.orange} />
            <T
              variant="caption"
              style={{ color: tokens.orange, fontWeight: '700', marginLeft: spacing.xs }}
            >
              {t('comments:spoilerWarning')}
            </T>
            <T variant="micro" muted style={{ marginTop: 2 }}>
              {t('comments:viewSpoiler')}
            </T>
          </Pressable>
        ) : null}

        {!tombstone && comment.hasLocalRevision ? (
          <T variant="micro" muted style={{ marginBottom: spacing.sm }}>
            {t('comments:commsuni.localRevision', { appName: t('common:appName') })}
          </T>
        ) : null}
        {!comment.hasLocalRevision &&
        comment.commsUniState &&
        comment.commsUniState !== 'SYNCED' &&
        commsUniOperationMessage({ state: comment.commsUniState }) ? (
          <T variant="micro" muted style={{ marginBottom: spacing.sm }}>
            {t(commsUniOperationMessage({ state: comment.commsUniState })!)}
          </T>
        ) : null}
        {/* Body */}
        {tombstone ? (
          <T variant="body" muted style={[styles.body, { fontStyle: 'italic' }]}>
            {t('comments:deleted')}
          </T>
        ) : !censored && comment.body ? (
          <TranslatableContent
            id={comment.shared?.comment.id ?? comment.reviewId ?? comment.id}
            conversation={comment.shared}
            mentions={comment.shared?.comment.mentions}
            kind={comment.kind === 'review' ? 'review' : 'comment'}
            content={
              comment.content ?? {
                original: comment.body,
                format: 'plain',
                eligible: false,
              }
            }
            style={styles.body}
          />
        ) : null}

        {/* Media (image/GIF) — fills card width, opens full-screen viewer */}
        {!tombstone && !censored ? (
          <CommentMedia
            image={comment.image}
            gifUrl={comment.gifUrl}
            shared={comment.shared}
            visible={visible}
          />
        ) : null}

        {/* Attached show/movie card — opens the media detail page */}
        {!tombstone && !censored && comment.media ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              openMedia(comment.media!);
            }}
            style={({ pressed }) => [
              styles.mediaCard,
              { backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={comment.media.title}
          >
            <PosterImage uri={comment.media.posterUrl} style={styles.mediaPoster} />
            <View style={styles.mediaMeta}>
              <T variant="caption" style={{ fontWeight: '700' }} numberOfLines={2}>
                {comment.media.title}
              </T>
              <View style={styles.mediaMetaRow}>
                <Ionicons
                  name={comment.media.mediaType === 'SHOW' ? 'tv-outline' : 'film-outline'}
                  size={12}
                  color={tokens.textMuted}
                />
                {comment.media.year ? (
                  <T variant="micro" muted style={{ marginLeft: 4 }}>
                    {comment.media.year}
                  </T>
                ) : null}
              </View>
            </View>
            <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
          </Pressable>
        ) : null}

        {/* Attached list card — opens the list page */}
        {!tombstone && !censored && comment.list ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              openList(comment.list!);
            }}
            style={({ pressed }) => [
              styles.mediaCard,
              { backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
            ]}
            accessibilityRole="button"
            accessibilityLabel={comment.list.title}
          >
            {comment.list.coverUrl ? (
              <PosterImage uri={comment.list.coverUrl} style={styles.listCover} />
            ) : (
              <View
                style={[
                  styles.listCover,
                  styles.listCoverFallback,
                  { backgroundColor: tokens.surface },
                ]}
              >
                <Ionicons name="list-outline" size={20} color={tokens.primary} />
              </View>
            )}
            <View style={styles.mediaMeta}>
              <T variant="caption" style={{ fontWeight: '700' }} numberOfLines={2}>
                {comment.list.title}
              </T>
              <T variant="micro" muted style={{ marginTop: 2 }}>
                {comment.list.movieCount > 0 ? `🎬 ${comment.list.movieCount}` : ''}
                {comment.list.movieCount > 0 && comment.list.showCount > 0 ? '  ' : ''}
                {comment.list.showCount > 0 ? `📺 ${comment.list.showCount}` : ''}
              </T>
            </View>
            <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {sharedLike.error ? (
        <T variant="micro" muted>
          {t('comments:failedToPost')}
        </T>
      ) : null}
      {/* Action row: like · reply (overflow is in the header) */}
      <View style={[styles.actions, { paddingLeft: contentIndent }]}>
        {onToggleCollapse ? (
          <Pressable
            onPress={onToggleCollapse}
            accessibilityRole="button"
            accessibilityLabel={t(collapsed ? 'comments:expandThread' : 'comments:collapseThread')}
            hitSlop={spacing.sm}
            style={{
              position: 'absolute',
              left: avatar / 2 - spacing.lg / 2,
              top: 0,
              bottom: 0,
              width: spacing.lg,
              justifyContent: 'center',
              backgroundColor: tokens.background,
            }}
          >
            <Ionicons
              name={collapsed ? 'add-circle-outline' : 'remove-circle-outline'}
              size={spacing.lg}
              color={tokens.textMuted}
            />
          </Pressable>
        ) : null}
        <Pressable
          onPress={(e) => {
            stop(e);
            if (comment.shared) void sharedLike.toggle();
            else if (canLike) onLike(comment);
          }}
          disabled={!canLike}
          hitSlop={8}
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel={t('comments:like')}
        >
          <Ionicons
            name={liked ? 'heart' : 'heart-outline'}
            size={18}
            color={liked ? tokens.favorite : !canLike ? tokens.textDim : tokens.textMuted}
          />
          <T variant="micro" muted style={{ marginLeft: 4 }}>
            {likesCount}
          </T>
        </Pressable>

        {(onReply ? commentCanReply(comment) : showReplyAction) ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              if (onReply) onReply(comment);
              else openThread();
            }}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t(onReply ? 'comments:reply' : 'comments:openThread')}
          >
            <Ionicons name="chatbubble-outline" size={18} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {onReply
                ? t('comments:reply')
                : comment.repliesCount > 0
                  ? comment.repliesCount === 1
                    ? t('common:replySingular', { count: 1 })
                    : t('common:replyPlural', { count: comment.repliesCount })
                  : t('comments:reply')}
            </T>
          </Pressable>
        ) : null}
        {comment.shared?.comment.rating != null ? (
          <T variant="micro" muted style={{ marginLeft: 'auto' }}>
            {comment.shared.comment.rating}/10
          </T>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: radius.lg, padding: spacing.md },
  cardCompact: { padding: spacing.sm, borderRadius: radius.md },
  cardPressed: { opacity: 0.97 },
  header: { flexDirection: 'row', alignItems: 'center' },
  nameCol: { flex: 1, minWidth: 0, marginLeft: spacing.md },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  overflowBtn: { padding: spacing.xs, marginLeft: spacing.xs, flexShrink: 0 },
  body: { marginTop: spacing.sm, lineHeight: 20 },
  spoilerCover: {
    marginTop: spacing.sm,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reviewBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
    marginLeft: spacing.xs,
  },
  reviewBadgeText: { fontWeight: '900', letterSpacing: 0.5, fontSize: 9 },
  mediaCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginTop: spacing.sm,
  },
  mediaPoster: { width: 36, height: 54, borderRadius: radius.sm },
  mediaMeta: { flex: 1, marginLeft: spacing.sm },
  mediaMetaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  listCover: { width: 54, height: 54, borderRadius: radius.sm },
  listCoverFallback: { alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
});
