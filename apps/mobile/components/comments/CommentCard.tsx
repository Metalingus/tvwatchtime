import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import type { CommentDto, CommentMediaRefDto } from '@tvwatch/shared';
import { formatDateTime } from '@tvwatch/shared';
import { PosterImage, T, APP_ICON } from '../primitives';
import { CommentMedia } from './CommentMedia';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

const AVATAR = 40;
const AVATAR_COMPACT = 32;

export interface CommentCardProps {
  comment: CommentDto;
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
}: CommentCardProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const tombstone = comment.deletedByUser;
  const avatar = compact ? AVATAR_COMPACT : AVATAR;
  const author = comment.author;

  const openThread = () => onOpenThread?.(comment);
  const openMedia = (media: CommentMediaRefDto) =>
    router.push(`/${media.mediaType === 'SHOW' ? 'show' : 'movie'}/${media.mediaId}` as any);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: tokens.cardBackground },
        compact && styles.cardCompact,
        interactive && pressed && styles.cardPressed,
      ]}
      onPress={interactive ? openThread : undefined}
      disabled={!interactive}
    >
      {/* Header: avatar · name/date · overflow (top-right) */}
      <View style={styles.header}>
        <Pressable
          onPress={(e) => {
            stop(e);
            onPressAuthor?.(comment);
          }}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={author?.username}
        >
          <PosterImage uri={author?.avatarUrl} fallback={APP_ICON} style={{ width: avatar, height: avatar, borderRadius: avatar / 2 }} />
        </Pressable>

        <View style={styles.nameCol}>
          <View style={styles.nameRow}>
            <T variant="caption" style={{ fontWeight: '700', color: tokens.textPrimary }}>
              {author?.username}
            </T>
            {comment.isEdited && !tombstone ? (
              <T variant="micro" muted style={{ marginLeft: spacing.xs }}>
                · {t('comments:edited')}
              </T>
            ) : null}
          </View>
          <T variant="micro" muted style={{ marginTop: 2 }}>
            {formatDateTime(comment.createdAt, resolvedLocale)}
          </T>
        </View>

        <Pressable
          onPress={(e) => {
            stop(e);
            onOverflow(comment);
          }}
          hitSlop={10}
          style={styles.overflowBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common:moreOptions')}
        >
          <Ionicons name="ellipsis-horizontal" size={20} color={tokens.textMuted} />
        </Pressable>
      </View>

      {/* Body */}
      {tombstone ? (
        <T variant="body" muted style={[styles.body, { fontStyle: 'italic' }]}>
          {t('comments:deleted')}
        </T>
      ) : comment.body ? (
        <T variant="body" style={styles.body}>
          {comment.body}
        </T>
      ) : null}

      {/* Media (image/GIF) — fills card width, opens full-screen viewer */}
      {!tombstone ? <CommentMedia image={comment.image} gifUrl={comment.gifUrl} /> : null}

      {/* Attached show/movie card — opens the media detail page */}
      {!tombstone && comment.media ? (
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

      {/* Action row: like · reply (overflow is in the header) */}
      <View style={styles.actions}>
        <Pressable
          onPress={(e) => {
            stop(e);
            if (!tombstone) onLike(comment);
          }}
          disabled={tombstone}
          hitSlop={8}
          style={styles.actionBtn}
          accessibilityRole="button"
          accessibilityLabel={t('comments:like')}
        >
          <Ionicons
            name={comment.likedByMe ? 'heart' : 'heart-outline'}
            size={18}
            color={comment.likedByMe ? tokens.favorite : tombstone ? tokens.textDim : tokens.textMuted}
          />
          <T variant="micro" muted style={{ marginLeft: 4 }}>
            {comment.likesCount}
          </T>
        </Pressable>

        {showReplyAction ? (
          <Pressable
            onPress={(e) => {
              stop(e);
              openThread();
            }}
            hitSlop={8}
            style={styles.actionBtn}
            accessibilityRole="button"
            accessibilityLabel={t('comments:openThread')}
          >
            <Ionicons name="chatbubble-outline" size={18} color={tokens.textMuted} />
            <T variant="micro" muted style={{ marginLeft: 4 }}>
              {comment.repliesCount > 0
                ? comment.repliesCount === 1
                  ? t('common:replySingular', { count: 1 })
                  : t('common:replyPlural', { count: comment.repliesCount })
                : t('comments:reply')}
            </T>
          </Pressable>
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
  nameCol: { flex: 1, marginLeft: spacing.md },
  nameRow: { flexDirection: 'row', alignItems: 'center' },
  overflowBtn: { padding: spacing.xs, marginLeft: spacing.xs },
  body: { marginTop: spacing.sm, lineHeight: 20 },
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
});
