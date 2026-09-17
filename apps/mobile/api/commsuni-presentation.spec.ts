import {
  mergePostedComments,
  replyMention,
  retainedMentions,
  presentSharedComment,
  presentThreadComment,
  patchLocalRevision,
  presentConversationItem,
  commentThreadUrl,
  commentReplyTarget,
  parseSharedThread,
  presentReplies,
  commentCanReply,
  sharedCommentPath,
} from './commsuni-presentation';
import type { CommentDto, CommsUniCommentDto, ConversationItemDto } from '@tvwatch/shared';

const saved = (id: string, state = 'PENDING') =>
  ({ id, body: 'Keep this', commsUniState: state }) as CommentDto;
const local = (id: string): ConversationItemDto => ({
  kind: 'local',
  key: 'local:' + id,
  comment: saved(id),
});

describe('shared posting presentation', () => {
  it('keeps a new zero-like post visible above a most-liked page that omits it', () => {
    const result = mergePostedComments([local('popular')], [saved('new')]);
    expect(result.map((row) => row.key)).toEqual(['local:new', 'local:popular']);
  });
  it('keeps failed posts and their text available', () => {
    const result = mergePostedComments([], [saved('new', 'FAILED')]);
    expect(result[0]).toMatchObject({ comment: { body: 'Keep this', commsUniState: 'FAILED' } });
  });
  it('merges a provider acknowledgement at the same key without duplicating the row', () => {
    const comment = { ...saved('new', 'SYNCED'), commsUniCommentId: 'remote' };
    const result = mergePostedComments(
      [
        {
          kind: 'commsuni',
          key: 'commsuni:remote',
          comment: { id: 'remote' },
        } as ConversationItemDto,
        local('popular'),
      ],
      [comment],
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      kind: 'commsuni',
      key: 'local:new',
      comment: { id: 'remote' },
    });
  });
  it('deduplicates a local echo and uses the fresher local delivery status', () => {
    expect(mergePostedComments([local('new')], [saved('new', 'SYNCED')])).toEqual([
      { kind: 'local', key: 'local:new', comment: saved('new', 'SYNCED') },
    ]);
  });
});

describe('structured reply mentions', () => {
  it.each(['Alice', 'Zoë 😀', 'مستخدم'])(
    'preserves a returned identity with display name %s',
    (displayName) => {
      const mention = replyMention({ id: 'provider-author-id', displayName });
      expect(retainedMentions(mention.text + ' Hello', [mention])).toEqual([mention]);
      expect(mention.text.slice(mention.start, mention.end)).toBe('@' + displayName);
    },
  );
  it('does not retain a mention when the user removes or changes its text', () => {
    const mention = replyMention({ id: 'provider-author-id', displayName: 'Alice' });
    expect(retainedMentions('@Bob Hello', [mention])).toEqual([]);
    expect(retainedMentions('Hello', [mention])).toEqual([]);
  });
});

it('deduplicates both local and remote echoes regardless of which arrived first', () => {
  const comment = { ...saved('new', 'SYNCED'), commsUniCommentId: 'remote' };
  const remote = {
    kind: 'commsuni',
    key: 'commsuni:remote',
    comment: { id: 'remote' },
  } as ConversationItemDto;
  for (const items of [
    [local('new'), remote],
    [remote, local('new')],
  ]) {
    expect(mergePostedComments(items, [comment])).toEqual([{ ...remote, key: 'local:new' }]);
  }
});

const remote: CommsUniCommentDto = {
  id: '11111111-1111-4111-8111-111111111111',
  entityId: '22222222-2222-4222-8222-222222222222',
  author: {
    id: '33333333-3333-4333-8333-333333333333',
    displayName: 'Remote author',
    avatarUrl: null,
  },
  text: 'A shared comment',
  createdAt: null,
  origin: { kind: 'tvtime', slug: 'tvtime', displayName: 'TV Time', iconUrl: null },
  parentCommentId: null,
  inReplyToCommentId: null,
  rootCommentId: '11111111-1111-4111-8111-111111111111',
  depth: 0,
  likeCount: 4,
  replyCount: 2,
  viewerLiked: true,
  spoilerCount: 0,
  isSpoiler: false,
  rating: null,
  language: null,
  mentions: [],
  media: null,
  actions: { like: true, reply: true, delete: false, spoiler: true, authorSpoiler: false },
};
describe('one presentation with explicit source identity', () => {
  it('projects provider fields without inventing local IDs or an unknown timestamp', () => {
    const view = presentSharedComment(remote, 'MOVIE', 'movie');
    expect(view.id).toBe('commsuni:' + remote.id);
    expect(view.author.id).toBe('commsuni:' + remote.author.id);
    expect(view.createdAt).toBe('');
    expect(view).toMatchObject({ likesCount: 4, likedByMe: true, sourceOrigin: remote.origin });
    expect(view.shared?.comment).toBe(remote);
  });
  it('routes both sources through the existing screen with an explicit remote source marker', () => {
    const view = presentSharedComment(remote, 'MOVIE', 'movie&other');
    const url = commentThreadUrl(view);
    expect(url).toBe(
      '/comment/' + remote.id + '?source=commsuni&threadType=MOVIE&threadId=movie%26other',
    );
    expect(commentThreadUrl({ ...saved('local'), kind: undefined })).toBe('/comment/local');
    expect(sharedCommentPath(view.shared!, '/actions')).toContain('threadId=movie%26other');
  });
  it('never sends a UI-prefixed ID or local ID as the remote reply target', () => {
    const view = presentSharedComment(remote, 'EPISODE', 'episode');
    expect(commentReplyTarget(view)).toEqual({
      commsUniParentId: remote.id,
      commsUniReplyAuthor: remote.author,
    });
    expect(commentReplyTarget(saved('local'))).toEqual({ parentId: 'local' });
  });
  it('keeps actions disabled when the provider does not grant them', () => {
    expect(
      commentCanReply(
        presentSharedComment(
          { ...remote, actions: { ...remote.actions, reply: false } },
          'SHOW',
          'show',
        ),
      ),
    ).toBe(false);
    expect(commentCanReply({ ...saved('deleted'), deletedByUser: true })).toBe(false);
  });
  it.each([
    { id: 'local', source: 'commsuni', threadType: 'MOVIE', threadId: 'm' },
    { id: remote.id, source: 'commsuni', threadType: 'GROUP', threadId: 'm' },
    { id: remote.id, source: 'commsuni', threadType: 'EPISODE' },
    { id: remote.id, threadType: 'MOVIE', threadId: 'm' },
  ])('rejects an invalid or unmarked remote route: %j', (params) => {
    expect(parseSharedThread(params)).toBeNull();
  });
  it('preserves the posted row key when a local post becomes a provider row', () => {
    const view = presentConversationItem(
      { kind: 'commsuni', key: 'local:posted', comment: remote },
      'MOVIE',
      'movie',
    );
    expect(view.renderKey).toBe('local:posted');
    expect(view.id).toBe('commsuni:' + remote.id);
  });
  it('places mixed/flattened replies under the viewed parent without changing their action targets', () => {
    const parent = presentSharedComment(remote, 'MOVIE', 'movie');
    const reply = {
      ...remote,
      id: '44444444-4444-4444-8444-444444444444',
      parentCommentId: 'storage-parent',
      inReplyToCommentId: remote.id,
      depth: 2,
    };
    const rows = presentReplies(
      [
        { kind: 'commsuni', key: 'remote-reply', comment: reply },
        { kind: 'local', key: 'local-reply', comment: saved('local-reply') },
      ],
      parent,
    );
    expect(rows.map((row) => row.parentId)).toEqual([parent.id, parent.id]);
    expect(commentReplyTarget(rows[0]).commsUniParentId).toBe(reply.id);
    expect(commentReplyTarget(rows[1]).parentId).toBe('local-reply');
  });
});

it.each(['SHOW', 'MOVIE'] as const)(
  'keeps a local %s attachment navigable in the merged community feed',
  (mediaType) => {
    const card = {
      ...saved('linked-card'),
      commsUniState: null,
      media: { mediaId: 'linked-media', mediaType, title: 'Linked title', posterUrl: null },
    } as CommentDto;
    const mixed: ConversationItemDto[] = [
      { kind: 'commsuni', key: 'commsuni:other', comment: { id: 'other' } } as ConversationItemDto,
      { kind: 'local', key: 'local:linked-card', comment: card },
    ];
    const merged = mergePostedComments(mixed, [card]);
    expect(merged).toHaveLength(2);
    const view = presentConversationItem(merged[0], 'MOVIE', 'conversation');
    expect(view.media).toEqual(card.media);
    expect(view.media?.mediaId).toBe('linked-media');
    expect(view.shared).toBeUndefined();
  },
);

it('displays a local revision on a shared deep link and keeps the local identity', () => {
  const comment = { ...saved('local-root'), hasLocalRevision: true, body: 'Local revision' };
  const result = presentThreadComment({
    comment: { id: 'remote-root', text: 'Original shared text' } as CommsUniCommentDto,
    localRevision: comment,
    thread: null,
    threadType: 'SHOW',
    threadId: 'show',
  });
  expect(result).toMatchObject({
    id: 'local-root',
    body: 'Local revision',
    commsUniCommentId: 'remote-root',
  });
  expect(result.shared).toBeUndefined();
});
it('retains mixed replies beneath a local revision of a shared root', () => {
  const parent = {
    ...saved('local-root'),
    hasLocalRevision: true,
    commsUniCommentId: 'remote-root',
    threadType: 'SHOW' as const,
    threadId: 'show',
  };
  const children = presentReplies([local('child')], parent);
  expect(children).toHaveLength(1);
  expect(children[0].parentId).toBe('local-root');
});

it('patches/deletes the local revision without changing the shared original in cache', () => {
  const original = { id: 'shared', text: 'Original snapshot' } as CommsUniCommentDto;
  const thread = {
    comment: original,
    localRevision: saved('local'),
    thread: null,
    threadType: 'SHOW' as const,
    threadId: 'show',
  };
  const updated = patchLocalRevision(thread, 'local', (comment) => ({
    ...comment,
    deletedByUser: true,
    body: '',
  }));
  expect(updated?.localRevision).toMatchObject({ body: '', deletedByUser: true });
  expect(updated?.comment).toBe(original);
  expect(patchLocalRevision(thread, 'another', (comment) => comment)).toBe(thread);
});

it('does not let a retained pending snapshot override an acknowledged local feed row', () => {
  const acknowledged = { ...saved('new', 'SYNCED'), commsUniCommentId: 'remote' };
  const result = mergePostedComments(
    [{ kind: 'local', key: 'local:new', comment: acknowledged }],
    [saved('new')],
  );
  expect(result).toMatchObject([
    { key: 'local:new', comment: { commsUniState: 'SYNCED', commsUniCommentId: 'remote' } },
  ]);
});

it('shows the user edit instead of a stale provider original while delivery runs in the background', () => {
  const edited = {
    ...saved('new', 'SYNCED'),
    body: 'My edit',
    hasLocalRevision: true,
    commsUniCommentId: 'remote',
    editedAt: '2026-09-14T18:00:00Z',
  };
  const original = {
    kind: 'commsuni',
    key: 'commsuni:remote',
    comment: { id: 'remote', text: 'Original' },
  } as ConversationItemDto;
  expect(mergePostedComments([original], [edited])).toMatchObject([
    { kind: 'local', key: 'local:new', comment: { body: 'My edit' } },
  ]);
});
it('keeps a fresh local edit when an older individual read arrives late', () => {
  const edited = {
    ...saved('new', 'SYNCED'),
    body: 'My edit',
    hasLocalRevision: true,
    editedAt: '2026-09-14T18:00:00Z',
  };
  expect(
    mergePostedComments(
      [{ kind: 'local', key: 'local:new', comment: edited }],
      [saved('new', 'SYNCED')],
    ),
  ).toMatchObject([{ comment: { body: 'My edit', hasLocalRevision: true } }]);
});
it('removes a deleted new comment from both retained posts and stale feed echoes', () => {
  expect(
    mergePostedComments(
      [local('new')],
      [{ ...saved('new'), deletedByUser: true, repliesCount: 0 }],
    ),
  ).toEqual([]);
});
