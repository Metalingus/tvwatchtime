import { isCommsUniPending } from '@tvwatch/shared';
import type {
  CommentDto,
  CommsUniCommentDto,
  CommsUniThreadDto,
  CommsUniOrigin,
  ConversationType,
  ConversationItemDto,
  CommsUniWriteMention,
} from '@tvwatch/shared';

export function replyMention(author: { id: string; displayName: string }) {
  const text = '@' + author.displayName;
  return { authorId: author.id, start: 0, end: text.length, text };
}

/** Editing/deleting an injected span never silently mentions a different person. */
export function retainedMentions(body: string, mentions: CommsUniWriteMention[]) {
  return mentions.filter((mention) => body.slice(mention.start, mention.end) === mention.text);
}

/** A delayed pending snapshot must not undo an acknowledged publication. */
export function acknowledgeComment(comment: CommentDto, known?: CommentDto): CommentDto {
  return isCommsUniPending(comment.commsUniState) && known?.commsUniState === 'SYNCED'
    ? {
        ...comment,
        commsUniState: 'SYNCED',
        commsUniCommentId: known.commsUniCommentId ?? comment.commsUniCommentId,
      }
    : comment;
}

/** Keep newly saved rows at a stable position, merging the provider acknowledgement in place. */
export function mergePostedComments(items: ConversationItemDto[], posted: CommentDto[]) {
  const remaining = [...items];
  const pinned = posted.flatMap((saved): ConversationItemDto[] => {
    const echo = items.find((item) => item.kind === 'local' && item.comment.id === saved.id);
    const local = echo?.kind === 'local' ? echo.comment : undefined;
    const editedTime = (value?: string | null) => Date.parse(value ?? '') || 0;
    const fresh =
      local && (local.deletedByUser || editedTime(local.editedAt) > editedTime(saved.editedAt))
        ? local
        : saved;
    const comment = acknowledgeComment(fresh, local);
    const matches = (item: ConversationItemDto) =>
      item.kind === 'local'
        ? item.comment.id === comment.id
        : !!comment.commsUniCommentId && item.comment.id === comment.commsUniCommentId;
    const item = remaining.find((entry) => entry.kind === 'commsuni' && matches(entry));
    for (let index = remaining.length - 1; index >= 0; index--)
      if (matches(remaining[index])) remaining.splice(index, 1);
    if (comment.deletedByUser && !comment.repliesCount) return [];
    return [
      item?.kind === 'commsuni' && !comment.hasLocalRevision
        ? { ...item, key: 'local:' + comment.id }
        : { kind: 'local', key: 'local:' + comment.id, comment },
    ];
  });
  const seen = new Set(pinned.map((item) => item.key));
  return [...pinned, ...remaining.filter((item) => !seen.has(item.key))];
}

/** UI projection only. Provider IDs remain explicit and never become local user/comment IDs. */
export type CommentView = CommentDto & {
  shared?: { comment: CommsUniCommentDto; threadType: ConversationType; threadId: string };
  renderKey?: string;
  sourceOrigin?: CommsUniOrigin;
};
export const providerCommentKey = (id: string) => 'commsuni:' + id;

export function presentSharedComment(
  comment: CommsUniCommentDto,
  threadType: ConversationType,
  threadId: string,
): CommentView {
  return {
    id: providerCommentKey(comment.id),
    parentId: comment.parentCommentId ? providerCommentKey(comment.parentCommentId) : null,
    threadType,
    threadId,
    depth: comment.depth,
    author: {
      id: providerCommentKey(comment.author.id),
      username: comment.author.displayName,
      displayName: comment.author.displayName,
      avatarUrl: comment.author.avatarUrl,
      followingCount: 0,
      followersCount: 0,
      commentsCount: 0,
      createdAt: '',
    },
    body: comment.text ?? '',
    content: {
      original: comment.text ?? '',
      format: 'plain',
      sourceLanguage: comment.language,
      eligible: !!comment.text,
    },
    // Empty means unknown; presentations omit it rather than inventing an archive date.
    createdAt: comment.createdAt ?? '',
    likesCount: comment.likeCount,
    repliesCount: comment.replyCount,
    likedByMe: comment.viewerLiked ?? false,
    reportedByMe: false,
    isSpoiler: comment.isSpoiler,
    spoilerCount: comment.spoilerCount,
    spoilerReportedByMe: comment.viewerMarkedSpoiler ?? false,
    deletedByUser: comment.deleted === true,
    isEdited: false,
    sourceOrigin: comment.origin,
    shared: { comment, threadType, threadId },
  };
}
export function presentThreadComment(thread: CommsUniThreadDto): CommentView {
  return thread.localRevision
    ? {
        ...thread.localRevision,
        commsUniCommentId: thread.comment.id,
        renderKey: 'local:' + thread.localRevision.id,
      }
    : presentSharedComment(thread.comment, thread.threadType, thread.threadId);
}

export function presentConversationItem(
  item: ConversationItemDto,
  threadType: ConversationType,
  threadId: string,
  sources?: CommsUniOrigin[],
): CommentView {
  return item.kind === 'commsuni'
    ? { ...presentSharedComment(item.comment, threadType, threadId), renderKey: item.key }
    : {
        ...item.comment,
        renderKey: item.key,
        sourceOrigin: localCommentOrigin(item.localSource, sources),
      };
}
export function commentThreadUrl(comment: CommentView) {
  if (comment.kind === 'review') return '/review/' + encodeURIComponent(comment.reviewId!);
  if (!comment.shared) return '/comment/' + encodeURIComponent(comment.id);
  const { comment: remote, threadType, threadId } = comment.shared;
  return (
    '/comment/' +
    encodeURIComponent(remote.id) +
    '?source=commsuni&threadType=' +
    threadType +
    '&threadId=' +
    encodeURIComponent(threadId)
  );
}
export function sharedCommentPath(shared: NonNullable<CommentView['shared']>, suffix: string) {
  return (
    '/conversations/comments/' +
    encodeURIComponent(shared.comment.id) +
    suffix +
    '?threadType=' +
    shared.threadType +
    '&threadId=' +
    encodeURIComponent(shared.threadId)
  );
}
export function commentReplyTarget(comment: CommentView) {
  return comment.shared
    ? {
        commsUniParentId: comment.shared.comment.id,
        commsUniReplyAuthor: comment.shared.comment.author,
      }
    : { parentId: comment.id };
}
export function commentCanReply(comment: CommentView) {
  return !comment.deletedByUser && (comment.shared?.comment.actions.reply ?? true);
}
/** Validate an explicit provider route; malformed remote links must never fall through to local lookup. */
export function parseSharedThread(params: {
  id?: string;
  source?: string;
  threadType?: string;
  threadId?: string;
}) {
  if (params.source !== 'commsuni') return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id ?? '') ||
    !['SHOW', 'MOVIE', 'EPISODE'].includes(params.threadType ?? '') ||
    !params.threadId
  )
    return null;
  return {
    id: params.id!,
    threadType: params.threadType as ConversationType,
    threadId: params.threadId,
  };
}
/** Provider reply pages target the selected comment even when archived storage is flattened. */
export function presentReplies(
  items: ConversationItemDto[],
  parent: CommentView,
  sources?: CommsUniOrigin[],
): CommentView[] {
  const threadType = parent.shared?.threadType ?? parent.threadType;
  if (threadType === 'GROUP' || (!parent.shared && !parent.commsUniCommentId)) return [];
  return items.map((item) => ({
    ...presentConversationItem(item, threadType, parent.threadId, sources),
    parentId: parent.id,
  }));
}

export function localCommentOrigin(
  source: string | null | undefined,
  sources: CommsUniOrigin[] = [],
): CommsUniOrigin | undefined {
  if (!source || source === 'MANUAL') return undefined;
  const slug = source.toLowerCase();
  return (
    sources.find((origin) => origin.slug === slug) ?? {
      slug,
      displayName: source === 'TVTIME' ? 'TV Time' : source,
      kind: 'unknown',
      iconUrl: null,
    }
  );
}

/** Native edits/deletions patch the local copy, never the immutable provider payload. */
export function patchLocalRevision(
  thread: CommsUniThreadDto | undefined,
  commentId: string,
  patch: (comment: CommentDto) => CommentDto,
): CommsUniThreadDto | undefined {
  return thread?.localRevision?.id === commentId
    ? { ...thread, localRevision: patch(thread.localRevision) }
    : thread;
}
