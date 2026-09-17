import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { CommentView as CommentDto } from '../../api/commsuni-presentation';
import { CommentCard } from './CommentCard';
import { T } from '../primitives';
import {
  THREAD_AVATAR,
  THREAD_CENTER_Y,
  THREAD_ELBOW_R,
  THREAD_GUTTER,
  THREAD_ROW_PAD_TOP,
  type ExpandedNode,
} from './thread-utils';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

/** Avatar center X within a node (avatar starts at the node's left edge). */
const AVATAR_CX = THREAD_AVATAR / 2;
/** Own thread line X (2px wide, centered on the avatar center). */
const OWN_LINE_LEFT = AVATAR_CX - 1;
/** Parent's thread line X, relative to this node (one gutter to the left). */
const PARENT_LINE_LEFT = OWN_LINE_LEFT - THREAD_GUTTER;

export interface ThreadHandlers {
  onLike: (c: CommentDto) => void;
  onOverflow: (c: CommentDto) => void;
  onPressAuthor?: (c: CommentDto) => void;
  onReply?: (c: CommentDto) => void;
  onToggleCollapse?: (c: CommentDto) => void;
  onLoadMore: (node: CommentDto) => void;
  isOwner: (c?: CommentDto | null) => boolean;
}

interface NodeContentProps {
  comment: CommentDto;
  depth: number;
  collapsed: boolean;
  handlers: ThreadHandlers;
  /** Transient highlight (e.g. opened from a notification) — cleared by the screen. */
  highlighted?: boolean;
  visible?: boolean;
}

/**
 * The comment itself: avatar + username/time header, body, attachments, actions.
 * Thread lines live in ThreadNode around this — the own line emerges from the
 * avatar's bottom CENTER (hidden behind the circular avatar), like Reddit.
 */
export function NodeContent({
  comment,
  depth,
  collapsed,
  handlers,
  highlighted,
  visible = true,
}: NodeContentProps) {
  const { tokens } = useAppearance();
  const showCollapse = depth > 0 && !!handlers.onToggleCollapse && comment.repliesCount > 0;
  return (
    <View
      style={[
        styles.content,
        highlighted ? { backgroundColor: tokens.primarySoft, borderRadius: radius.md } : null,
      ]}
    >
      <CommentCard
        comment={comment}
        isOwner={handlers.isOwner(comment)}
        compact
        threadDepth={depth}
        visible={visible}
        onLike={handlers.onLike}
        onOverflow={handlers.onOverflow}
        onPressAuthor={handlers.onPressAuthor}
        onReply={handlers.onReply}
        collapsed={collapsed}
        onToggleCollapse={showCollapse ? () => handlers.onToggleCollapse?.(comment) : undefined}
      />
    </View>
  );
}

export interface ThreadNodeProps {
  node: CommentDto;
  depth: number;
  /** Last child of its parent — the parent's line ends at this node's avatar. */
  isLast?: boolean;
  childrenOf: Map<string, CommentDto[]>;
  collapsed: ReadonlySet<string>;
  expanded: Record<string, ExpandedNode | undefined>;
  handlers: ThreadHandlers;
  /** Comment id to highlight (notification deep-link), matched at any depth. */
  highlightId?: string | null;
  visibleIds?: ReadonlySet<string>;
}

/**
 * One comment + its nested replies (Reddit-style recursive tree).
 *
 * Geometry: the node is offset one gutter (28px) from its parent. Its own thread
 * line runs at the avatar's CENTER x, emerging from the avatar's bottom — and
 * only exists while the comment has visible replies (leaf comments get no line).
 * Depth-2+ nodes get a rounded elbow from the parent's line into the avatar.
 * Top-level comments are independent (the post is NOT treated as a parent: no
 * root line, no elbow). The parent's line ends at its last child's avatar via a
 * background mask. Lines render before the content so icons mask them on top.
 */
export function ThreadNode({
  node,
  depth,
  isLast = false,
  childrenOf,
  collapsed,
  expanded,
  handlers,
  highlightId,
  visibleIds,
}: ThreadNodeProps) {
  const { tokens } = useAppearance();
  const isCollapsed = collapsed.has(node.id);

  // Collapsed: subtree hidden entirely — no children, no line, no "show more".
  const loadedChildren = childrenOf.get(node.id) ?? [];
  const replyCount = Math.max(node.repliesCount, loadedChildren.length);
  const kids = isCollapsed ? [] : loadedChildren;
  const remaining =
    isCollapsed || expanded[node.id]?.exhausted ? 0 : Math.max(0, replyCount - kids.length);
  const showKids = kids.length > 0 || remaining > 0;
  const hasParentLine = depth >= 2;

  return (
    // Depth-1 nodes render flush to the left edge (no parent line, no elbow — the
    // gutter would be dead space); every deeper level indents one gutter.
    <View style={[styles.node, { marginLeft: hasParentLine ? THREAD_GUTTER : 0 }]}>
      {/* Last child: mask the parent's line below the point where the elbow's arc
          leaves it (arc start = CENTER_Y - R + 2), so the line ends exactly at the curve. */}
      {isLast && hasParentLine ? (
        <View
          style={[
            styles.lineMask,
            {
              backgroundColor: tokens.background,
              left: PARENT_LINE_LEFT - 1,
              top: THREAD_CENTER_Y - THREAD_ELBOW_R + 2,
              bottom: 0,
            },
          ]}
        />
      ) : null}
      {/* Elbow: rounded connector from the parent's line into the avatar's center. */}
      {hasParentLine ? (
        <View
          style={[
            styles.elbow,
            {
              borderColor: tokens.border,
              left: PARENT_LINE_LEFT,
              top: THREAD_CENTER_Y - THREAD_ELBOW_R,
              // From the parent's line to just past the avatar's center (the end
              // is hidden behind the circular avatar, so the curve "plugs into" it).
              width: AVATAR_CX + 2 - PARENT_LINE_LEFT,
              height: THREAD_ELBOW_R + 2,
            },
          ]}
        />
      ) : null}
      {/* Own line: avatar bottom center → element bottom (→ the ⊕ icon's center when
          collapsed, so the marker stays connected to the avatar). Only while replies
          show or the comment is collapsed with replies. Rendered BEFORE the content
          so the collapse icon masks it on top. */}
      {showKids || (isCollapsed && replyCount > 0) ? (
        <View
          style={[
            styles.vline,
            {
              backgroundColor: tokens.border,
              left: OWN_LINE_LEFT,
              top: THREAD_ROW_PAD_TOP + THREAD_AVATAR,
              bottom: isCollapsed ? 12 : 0,
            },
          ]}
        />
      ) : null}

      <NodeContent
        comment={replyCount === node.repliesCount ? node : { ...node, repliesCount: replyCount }}
        depth={depth}
        collapsed={isCollapsed}
        handlers={handlers}
        highlighted={node.id === highlightId}
        visible={!visibleIds || visibleIds.has(node.id)}
      />

      {/* Nested children + the "show more" row. */}
      {kids.map((kid, i) => (
        <ThreadNode
          key={kid.id}
          node={kid}
          depth={depth + 1}
          isLast={i === kids.length - 1 && remaining === 0}
          childrenOf={childrenOf}
          collapsed={collapsed}
          expanded={expanded}
          handlers={handlers}
          highlightId={highlightId}
          visibleIds={!visibleIds || visibleIds.has(node.id) ? undefined : visibleIds}
        />
      ))}
      {showKids && remaining > 0 ? (
        <ThreadMoreRow
          node={node}
          remaining={remaining}
          loading={!!expanded[node.id]?.loading}
          handlers={handlers}
        />
      ) : null}
    </View>
  );
}

interface ThreadMoreRowProps {
  node: CommentDto;
  remaining: number;
  loading: boolean;
  handlers: ThreadHandlers;
}

/** "Show more replies (N)" row — its marker sits on the parent's avatar-center line. */
function ThreadMoreRow({ node, remaining, loading, handlers }: ThreadMoreRowProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments']);

  return (
    <Pressable
      onPress={() => {
        if (!loading) handlers.onLoadMore(node);
      }}
      style={styles.moreRow}
      accessibilityRole="button"
    >
      {/* The parent's line ends at the marker — mask it below the icon. */}
      <View
        style={[
          styles.lineMask,
          { backgroundColor: tokens.background, left: OWN_LINE_LEFT - 1, top: 16, bottom: 0 },
        ]}
      />
      <View
        style={[
          styles.moreIconWrap,
          { backgroundColor: tokens.background, left: OWN_LINE_LEFT - 8 },
        ]}
      >
        <Ionicons
          name={loading ? 'hourglass-outline' : 'add-circle-outline'}
          size={18}
          color={tokens.primary}
        />
      </View>
      <T
        variant="caption"
        style={[styles.moreLabel, { color: tokens.primary, marginLeft: THREAD_GUTTER }]}
      >
        {loading ? t('comments:loadingMore') : t('comments:showMoreReplies', { count: remaining })}
      </T>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  node: { position: 'relative' },
  vline: { position: 'absolute', width: 2 },
  lineMask: { position: 'absolute', width: 4 },
  elbow: {
    position: 'absolute',
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    borderBottomLeftRadius: THREAD_ELBOW_R,
    backgroundColor: 'transparent',
  },
  content: { flex: 1, paddingTop: THREAD_ROW_PAD_TOP, paddingBottom: 2 },
  moreRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32, position: 'relative' },
  moreIconWrap: { position: 'absolute', width: 18, height: 18, top: 7 },
  moreLabel: { fontWeight: '700' },
});
