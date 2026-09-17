import React from 'react';
const { renderToStaticMarkup } = require('react-dom/server') as {
  renderToStaticMarkup: (node: React.ReactNode) => string;
};
import { CommentCard } from './CommentCard';
import { NodeContent, ThreadNode } from './ThreadNode';
import { CommentsFeed } from './CommentsFeed';
import CommentThreadScreen from '../../app/comment/[id]';
import {
  presentSharedComment,
  providerCommentKey,
  type CommentView,
} from '../../api/commsuni-presentation';
import type { CommsUniCommentDto } from '@tvwatch/shared';

let mockTheme: 'light' | 'dark' = 'light';
let mockParams: Record<string, string> = {};
let mockFeed: any;
let mockRemoteRoot: any;
let mockLocalRoot: any;
let mockTopLevel: CommentView[];
let mockComposerProps: any;
const mockPressables: any[] = [];
const mockLocalLike = jest.fn();
const mockSharedLike = jest.fn();
const mockOverflow = jest.fn();
const mockFeedHook = jest.fn();
const mockLocalRootHook = jest.fn();
const mockRemoteRootHook = jest.fn();
jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native-web');
  return {
    ...actual,
    Pressable: (props: any) => {
      mockPressables.push(props);
      return React.createElement(actual.Pressable, props);
    },
    FlatList: (props: any) => {
      mockTopLevel = props.data;
      return React.createElement(
        actual.View,
        {},
        props.ListHeaderComponent,
        ...props.data.map((item: any) =>
          React.createElement(React.Fragment, { key: item.id }, props.renderItem({ item })),
        ),
        props.ListFooterComponent,
      );
    },
  };
});
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: any) => React.createElement('span', { 'data-icon': name }),
}));
jest.mock('../Header', () => ({
  Header: ({ title }: any) => React.createElement('h1', {}, title),
}));
jest.mock('../primitives', () => ({
  T: ({ children, style, ...props }: any) =>
    React.createElement(
      jest.requireActual('react-native-web').Text,
      { style, testID: props.testID },
      children,
    ),
  Screen: ({ children, style }: any) =>
    React.createElement(jest.requireActual('react-native-web').View, { style }, children),
  Spinner: () => null,
  EmptyState: ({ title }: any) => React.createElement('div', {}, title),
  PosterImage: () => null,
}));
jest.mock('../ProfileAvatar', () => ({
  ProfileAvatar: ({ uri }: any) =>
    React.createElement('span', { 'data-avatar': uri ?? 'placeholder' }),
}));
jest.mock('./CommentSourceBadge', () => ({
  CommentSourceBadge: ({ origin }: any) =>
    React.createElement('span', { 'data-source': origin?.slug }),
}));
jest.mock('./CommentMedia', () => ({
  CommentMedia: ({ shared, visible }: any) =>
    React.createElement('div', {
      'data-media': shared ? 'provider' : 'local',
      'data-visible': String(visible),
    }),
}));
jest.mock('./TranslatableContent', () => ({
  TranslatableContent: ({ content, conversation }: any) =>
    React.createElement(
      'div',
      { 'data-translation-source': conversation ? 'provider' : 'local' },
      content.original,
    ),
}));
jest.mock('./CommentComposer', () => ({
  CommentComposer: (props: any) => {
    mockComposerProps = props;
    return React.createElement('div', {
      'data-composer-local': props.parentId,
      'data-composer-remote': props.commsUniParentId,
    });
  },
}));
jest.mock('./CommentEditDialog', () => ({ CommentEditDialog: () => null }));
jest.mock('./CommsUniAttribution', () => ({
  CommsUniAttribution: () => React.createElement('div', {}, 'attribution'),
}));
jest.mock('./CommentActions', () => ({ CommentActions: () => null }));
jest.mock('./useCommentActions', () => ({
  useCommentActions: () => ({ openOverflow: mockOverflow, dialog: {} }),
}));
jest.mock('../../lib/dialog', () => ({ showError: jest.fn() }));
jest.mock('../../context/PreferencesProvider', () => ({
  useAppearance: () => ({
    tokens: jest.requireActual('@tvwatch/shared').buildTokens(mockTheme),
    resolvedLocale: 'en',
  }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../../api/client', () => ({ api: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../../api/hooks', () => ({
  useMe: () => ({ data: { id: 'local-user' } }),
  useFeatureFlags: () => ({ data: { commsuni_read: true, commsuni_write: false } }),
  useToggleCommentLike: () => ({ mutate: mockLocalLike }),
  useToggleExternalReviewLike: () => ({ mutate: jest.fn() }),
  useComment: (...args: any[]) => {
    mockLocalRootHook(...args);
    return mockLocalRoot;
  },
}));
jest.mock('../../api/commsuni', () => ({
  useCommentFeed: (args: any) => {
    mockFeedHook(args);
    return mockFeed;
  },
  useCommsUniThread: (...args: any[]) => {
    mockRemoteRootHook(...args);
    return mockRemoteRoot;
  },
  useSharedCommentLike: (comment: CommentView) => ({
    liked: comment.likedByMe,
    count: comment.likesCount,
    busy: false,
    error: false,
    toggle: mockSharedLike,
  }),
}));

const provider: CommsUniCommentDto = {
  id: '11111111-1111-4111-8111-111111111111',
  entityId: '22222222-2222-4222-8222-222222222222',
  author: {
    id: '33333333-3333-4333-8333-333333333333',
    displayName: 'Archive author',
    avatarUrl: null,
  },
  text: 'Shared body',
  createdAt: null,
  origin: { kind: 'tvtime', slug: 'tvtime', displayName: 'TV Time', iconUrl: null },
  parentCommentId: null,
  inReplyToCommentId: null,
  rootCommentId: '11111111-1111-4111-8111-111111111111',
  depth: 0,
  likeCount: 4,
  replyCount: 0,
  viewerLiked: true,
  spoilerCount: 0,
  isSpoiler: false,
  rating: null,
  language: null,
  mentions: [],
  media: { kind: 'archive' },
  actions: { like: true, reply: true, delete: false, spoiler: true, authorSpoiler: false },
};
const native: CommentView = {
  id: 'local',
  threadType: 'MOVIE',
  threadId: 'movie',
  depth: 0,
  body: 'Local body',
  createdAt: '2026-01-01T00:00:00Z',
  author: {
    id: 'local-user',
    username: 'Local author',
    createdAt: '',
    commentsCount: 1,
    followersCount: 0,
    followingCount: 0,
  },
  likesCount: 2,
  likedByMe: false,
  repliesCount: 0,
  isSpoiler: false,
  spoilerCount: 0,
  spoilerReportedByMe: false,
  reportedByMe: false,
  deletedByUser: false,
  isEdited: false,
};
const shared = () => presentSharedComment(provider, 'MOVIE', 'movie');
const props = (comment: CommentView) => ({
  comment,
  isOwner: false,
  onLike: mockLocalLike,
  onOverflow: mockOverflow,
  showReplyAction: true,
});
const click = (label: string, index = 0) => {
  const action = mockPressables.filter((p) => p.accessibilityLabel === label)[index];
  expect(action).toBeDefined();
  if (!action.disabled) action.onPress({ stopPropagation: jest.fn() });
  return action;
};
beforeEach(() => {
  jest.clearAllMocks();
  mockPressables.length = 0;
  mockParams = {};
  mockFeed = {
    items: [],
    isLoading: false,
    isError: false,
    isRefetching: false,
    refresh: jest.fn(),
    retain: jest.fn(),
  };
  mockRemoteRoot = { data: undefined, isLoading: false, isError: false, refetch: jest.fn() };
  mockLocalRoot = { data: undefined, isLoading: false, isError: false, refetch: jest.fn() };
  mockTopLevel = [];
});
it.each(['light', 'dark'] as const)(
  'renders both sources through the common card in %s',
  (theme) => {
    mockTheme = theme;
    const html = renderToStaticMarkup(
      <>
        <CommentCard {...props(native)} />
        <CommentCard {...props(shared())} />
      </>,
    );
    expect(html).toContain('Local body');
    expect(html).toContain('Shared body');
    expect(html).toContain('data-source="tvtime"');
    expect(html).toContain('data-avatar="placeholder"');
    expect(html).toContain('data-translation-source="local"');
    expect(html).toContain('data-translation-source="provider"');
    expect(html).not.toContain('Invalid Date');
  },
);
it.each(['local', 'provider'])('shields text and media for a spoiler from %s', (source) => {
  const comment = { ...(source === 'local' ? native : shared()), isSpoiler: true };
  const html = renderToStaticMarkup(<CommentCard {...props(comment)} />);
  expect(html).toContain('comments:spoilerWarning');
  expect(html).not.toContain(comment.body);
  expect(html).not.toContain('data-media=');
});
it('uses local and provider like handlers without mixing namespaces', () => {
  renderToStaticMarkup(
    <>
      <CommentCard {...props(native)} />
      <CommentCard {...props(shared())} />
    </>,
  );
  click('comments:like', 0);
  click('comments:like', 1);
  expect(mockLocalLike).toHaveBeenCalledWith(native);
  expect(mockLocalLike).toHaveBeenCalledTimes(1);
  expect(mockSharedLike).toHaveBeenCalledTimes(1);
});
it('honors unavailable like and account reply capabilities', () => {
  const comment = presentSharedComment(
    { ...provider, actions: { ...provider.actions, like: false, reply: false } },
    'MOVIE',
    'movie',
  );
  renderToStaticMarkup(<CommentCard {...props(comment)} onReply={jest.fn()} />);
  expect(click('comments:like').disabled).toBe(true);
  expect(mockSharedLike).not.toHaveBeenCalled();
  expect(mockPressables.some((p) => p.accessibilityLabel === 'comments:reply')).toBe(false);
});
it('retains real local reply actions in the same thread presentation', () => {
  const onReply = jest.fn();
  const handlers = {
    onLike: mockLocalLike,
    onOverflow: mockOverflow,
    onReply,
    onLoadMore: jest.fn(),
    isOwner: () => true,
  };
  renderToStaticMarkup(
    <NodeContent comment={native} depth={1} collapsed={false} handlers={handlers} />,
  );
  click('comments:like');
  click('comments:reply');
  click('common:moreOptions');
  expect(mockLocalLike).toHaveBeenCalledWith(native);
  expect(onReply).toHaveBeenCalledWith(native);
  expect(mockOverflow).toHaveBeenCalledWith(native);
});
it('starts nested media when its containing FlatList row is visible', () => {
  const root = { ...native, repliesCount: 1 };
  const child = { ...native, id: 'child', parentId: root.id };
  const html = renderToStaticMarkup(
    <ThreadNode
      node={root}
      depth={1}
      childrenOf={new Map([[root.id, [child]]])}
      collapsed={new Set()}
      expanded={{}}
      visibleIds={new Set([root.id])}
      handlers={{
        onLike: mockLocalLike,
        onOverflow: mockOverflow,
        onLoadMore: jest.fn(),
        isOwner: () => false,
      }}
    />,
  );
  expect(html.match(/data-visible="true"/g)).toHaveLength(2);
});
it('renders a mixed feed with one card implementation and working local likes', () => {
  mockFeed.items = [native, shared()];
  renderToStaticMarkup(<CommentsFeed threadType="MOVIE" threadId="movie" title="Movie" />);
  expect(mockFeedHook).toHaveBeenCalledWith(expect.objectContaining({ shared: true }));
  click('comments:like', 0);
  click('comments:like', 1);
  expect(mockLocalLike).toHaveBeenCalledWith({ commentId: 'local', liked: false });
  expect(mockSharedLike).toHaveBeenCalledTimes(1);
});
it('keeps group comments on the existing local backend', () => {
  renderToStaticMarkup(<CommentsFeed threadType="GROUP" threadId="group" title="Group" />);
  expect(mockFeedHook).toHaveBeenCalledWith(
    expect.objectContaining({ shared: false, threadType: 'GROUP' }),
  );
});
it('uses the existing thread screen for provider roots and wires local reply likes', () => {
  mockParams = { id: provider.id, source: 'commsuni', threadType: 'MOVIE', threadId: 'movie' };
  mockRemoteRoot.data = { comment: provider, threadType: 'MOVIE', threadId: 'movie' };
  mockFeed.items = [{ ...native, parentId: providerCommentKey(provider.id) }];
  const html = renderToStaticMarkup(<CommentThreadScreen />);
  expect(mockLocalRootHook).toHaveBeenCalledWith(provider.id, false, false);
  expect(mockRemoteRootHook).toHaveBeenCalledWith('MOVIE', 'movie', provider.id, true);
  expect(html).toContain('data-composer-remote="' + provider.id + '"');
  click('comments:like', 1);
  expect(mockLocalLike).toHaveBeenCalledWith(
    { commentId: 'local', liked: false },
    expect.any(Object),
  );
});
it('does not fall through to a local lookup for malformed provider deep links', () => {
  mockParams = { id: 'local-id', source: 'commsuni', threadType: 'GROUP', threadId: 'group' };
  const html = renderToStaticMarkup(<CommentThreadScreen />);
  expect(mockLocalRootHook).toHaveBeenCalledWith('local-id', false, false);
  expect(mockRemoteRootHook).toHaveBeenCalledWith('MOVIE', '', '', false);
  expect(html).toContain('comments:failedToLoad');
});

it('rejects unknown source markers without trying the local comment endpoint', () => {
  mockParams = { id: provider.id, source: 'unknown', threadType: 'MOVIE', threadId: 'movie' };
  renderToStaticMarkup(<CommentThreadScreen />);
  expect(mockLocalRootHook).toHaveBeenCalledWith(provider.id, false, false);
  expect(mockRemoteRootHook).toHaveBeenCalledWith('MOVIE', '', '', false);
});

it.each([1, 2])(
  'keeps the reply icon beside likes and targets the selected depth-%s message with publishing off',
  (depth) => {
    const root = { ...provider, actions: { ...provider.actions, like: false, reply: true } };
    const child = {
      ...root,
      id: '44444444-4444-4444-8444-444444444444',
      depth,
      author: { ...root.author, displayName: 'Individual author' },
    };
    mockParams = { id: root.id, source: 'commsuni', threadType: 'MOVIE', threadId: 'movie' };
    mockRemoteRoot.data = { comment: root, threadType: 'MOVIE', threadId: 'movie' };
    mockFeed.items = [
      { ...presentSharedComment(child, 'MOVIE', 'movie'), parentId: providerCommentKey(root.id) },
    ];
    let selected: CommentView | null = null;
    const realState = React.useState;
    const drawThread = () => {
      let stateIndex = 0;
      mockPressables.length = 0;
      const spy = jest.spyOn(React, 'useState').mockImplementation((initial?: any) => {
        const value = realState(initial);
        // Drive the actual screen's replyTarget state between server-rendered interaction steps.
        return stateIndex++ === 4
          ? ([
              selected,
              (next: CommentView | null) => {
                selected = next;
              },
            ] as any)
          : value;
      });
      try {
        return renderToStaticMarkup(<CommentThreadScreen />);
      } finally {
        spy.mockRestore();
      }
    };
    const html = drawThread();
    expect(html.match(/data-icon="chatbubble-outline"/g)).toHaveLength(2);
    expect(
      mockPressables.filter((button) => button.accessibilityLabel === 'comments:reply'),
    ).toHaveLength(2);
    expect(
      mockPressables
        .filter((button) => button.accessibilityLabel === 'comments:like')
        .every((button) => button.disabled),
    ).toBe(true);
    click('comments:reply', 1);
    drawThread();
    expect(mockComposerProps.commsUniParentId).toBe(child.id);
    expect(mockComposerProps.parentId).toBeUndefined();
    expect(mockComposerProps.commsUniReplyAuthor.displayName).toBe('Individual author');
    mockComposerProps.onCancelReply();
    drawThread();
    expect(mockComposerProps.commsUniParentId).toBe(root.id);
  },
);

/** Carry real screen state across select/create/cancel render steps; queries stay unchanged. */
function interactiveThread(sort = 'LATEST') {
  const state: any[] = [sort];
  const realState = React.useState;
  const draw = () => {
    let index = 0;
    mockPressables.length = 0;
    const spy = jest.spyOn(React, 'useState').mockImplementation((initial?: any) => {
      const value = realState(initial);
      const slot = index++;
      if (slot >= 7) return value;
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial;
      return [
        state[slot],
        (next: any) => {
          state[slot] = typeof next === 'function' ? next(state[slot]) : next;
        },
      ] as any;
    });
    try {
      return renderToStaticMarkup(<CommentThreadScreen />);
    } finally {
      spy.mockRestore();
    }
  };
  return { draw, state };
}
it.each([
  ['provider', 'LATEST'],
  ['provider', 'MOST_LIKED'],
  ['local', 'LATEST'],
  ['local', 'MOST_LIKED'],
])(
  'in a %s thread sorted %s, creates test -> test 2 -> test 3 under their selected parents without a refresh',
  (source, sort) => {
    const rootId = source === 'provider' ? providerCommentKey(provider.id) : 'root-local';
    if (source === 'provider') {
      mockParams = { id: provider.id, source: 'commsuni', threadType: 'MOVIE', threadId: 'movie' };
      mockRemoteRoot.data = { comment: provider, threadType: 'MOVIE', threadId: 'movie' };
    } else {
      mockParams = { id: rootId };
      mockLocalRoot.data = { ...native, id: rootId, body: 'Root' };
    }
    const first = { ...native, id: 'test-1', body: 'test one', parentId: rootId, repliesCount: 0 };
    const second = {
      ...native,
      id: 'test-2',
      body: 'test two',
      parentId: first.id,
      repliesCount: 0,
    };
    const third = {
      ...native,
      id: 'test-3',
      body: 'test three',
      parentId: second.id,
      repliesCount: 0,
    };
    mockFeed.items = [first];
    const session = interactiveThread(sort);
    session.draw();
    click('comments:reply', 1);
    session.draw();
    expect(mockComposerProps.parentId).toBe(first.id);
    mockComposerProps.onCreated(second);
    mockComposerProps.onSent(second.id);
    const afterSecond = session.draw();
    expect(mockTopLevel.map((row) => row.id)).toEqual([first.id]);
    expect(afterSecond).toContain(second.body);
    expect(
      mockPressables.filter((button) => button.accessibilityLabel === 'comments:collapseThread'),
    ).toHaveLength(1);
    click('comments:reply', 2);
    session.draw();
    expect(mockComposerProps.parentId).toBe(second.id);
    mockComposerProps.onCreated(third);
    mockComposerProps.onSent(third.id);
    const afterThird = session.draw();
    expect(mockTopLevel.map((row) => row.id)).toEqual([first.id]);
    expect(session.state[3][second.id].items).toEqual([third]);
    expect(afterThird.indexOf(first.body)).toBeLessThan(afterThird.indexOf(second.body));
    expect(afterThird.indexOf(second.body)).toBeLessThan(afterThird.indexOf(third.body));
    expect(
      mockPressables.filter((button) => button.accessibilityLabel === 'comments:collapseThread'),
    ).toHaveLength(2);
    expect(mockFeed.retain).not.toHaveBeenCalled();
    expect(mockFeed.refresh).not.toHaveBeenCalled();
    expect(mockRemoteRoot.refetch).not.toHaveBeenCalled();
    expect(mockLocalRoot.refetch).not.toHaveBeenCalled();
  },
);
it('inserts a reply under an individual provider message and reveals its collapsed subtree', () => {
  const providerChild = {
    ...provider,
    id: '44444444-4444-4444-8444-444444444444',
    depth: 1,
    replyCount: 1,
  };
  const child = {
    ...presentSharedComment(providerChild, 'MOVIE', 'movie'),
    parentId: providerCommentKey(provider.id),
  };
  mockParams = { id: provider.id, source: 'commsuni', threadType: 'MOVIE', threadId: 'movie' };
  mockRemoteRoot.data = { comment: provider, threadType: 'MOVIE', threadId: 'movie' };
  mockFeed.items = [child];
  const session = interactiveThread();
  session.state[2] = new Set([child.id]);
  session.draw();
  click('comments:reply', 1);
  session.draw();
  expect(mockComposerProps.commsUniParentId).toBe(providerChild.id);
  const saved = { ...native, id: 'new-local', body: 'Nested provider reply', parentId: null };
  mockComposerProps.onCreated(saved);
  mockComposerProps.onSent(saved.id);
  const html = session.draw();
  expect(session.state[2].has(child.id)).toBe(false);
  expect(session.state[3][child.id].items[0].parentId).toBe(child.id);
  expect(saved.parentId).toBeNull();
  expect(mockTopLevel.map((row) => row.id)).toEqual([child.id]);
  expect(html).toContain(saved.body);
  expect(mockFeed.retain).not.toHaveBeenCalled();
});
