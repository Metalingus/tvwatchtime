import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { PosterImage, T } from '../primitives';
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
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const tombstone = comment.deletedByUser;
  const avatar = compact ? AVATAR_COMPACT : AVATAR;
  const author = comment.author;

  const openThread = () => onOpenThread?.(comment);

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
          <PosterImage uri={author?.avatarUrl} style={{ width: avatar, height: avatar, borderRadius: avatar / 2 }} />
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
            {new Date(comment.createdAt).toLocaleDateString()}
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
  actions: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg, marginTop: spacing.sm },
  actionBtn: { flexDirection: 'row', alignItems: 'center' },
});
