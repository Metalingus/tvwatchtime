import React from 'react';
import { CommentActions } from './CommentActions';
import { presentSharedComment, type CommentView } from '../../api/commsuni-presentation';

const mockPost = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();
const mockOperation = { data: undefined as any, isError: false, refetch: jest.fn() };
const mockPlatform = { OS: 'ios' };
const mockCache = {
  setQueriesData: jest.fn(),
  invalidateQueries: jest.fn().mockResolvedValue(undefined),
  resetQueries: jest.fn().mockResolvedValue(undefined),
};
jest.mock('react-native', () => ({
  Modal: 'Modal',
  View: 'View',
  ScrollView: 'ScrollView',
  Pressable: 'Pressable',
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  Platform: {
    get OS() {
      return mockPlatform.OS;
    },
  },
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => 'test-action-id' }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockCache }));
jest.mock('../../api/commsuni', () => ({ useCommsUniOperation: () => mockOperation }));
jest.mock('../../api/hooks', () => ({ useDeleteComment: () => ({ mutateAsync: mockDelete }) }));
jest.mock('../../api/client', () => ({
  api: { post: (...args: any[]) => mockPost(...args), get: (...args: any[]) => mockGet(...args) },
}));
jest.mock('../../context/PreferencesProvider', () => ({
  useAppearance: () => ({ tokens: jest.requireActual('@tvwatch/shared').buildTokens('dark') }),
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('../primitives', () => ({ T: 'Text' }));

const native = {
  id: 'local-comment',
  body: 'Text',
  threadType: 'MOVIE',
  threadId: 'movie',
  author: { id: 'local-author', username: 'Local' },
} as CommentView;
const remote = presentSharedComment(
  {
    id: '11111111-1111-4111-8111-111111111111',
    author: { id: 'remote-author', displayName: 'Remote', avatarUrl: null },
    actions: { like: false, reply: false, delete: false, spoiler: false, authorSpoiler: false },
    text: 'Text',
    mentions: [],
    origin: { slug: 'other' },
  } as any,
  'MOVIE',
  'movie&other',
);
function draw(comment: CommentView, step = 'menu', isOwner = false, delivery: any = null) {
  const setters = [jest.fn(), jest.fn(), jest.fn(), jest.fn(), jest.fn()];
  const pendingEdit = { current: null as CommentView | null };
  const state = jest.spyOn(React, 'useState');
  [true, step, false, null, delivery].forEach((value, index) =>
    state.mockImplementationOnce(() => [value, setters[index]] as any),
  );
  const ref = jest
    .spyOn(React, 'useRef')
    .mockImplementationOnce(() => pendingEdit)
    .mockImplementationOnce(() => ({ current: false }));
  const effects: (() => any)[] = [];
  const effect = jest.spyOn(React, 'useEffect').mockImplementation((fn) => {
    effects.push(fn);
  });
  const onClose = jest.fn(),
    onEdit = jest.fn();
  const tree = CommentActions({ comment, isOwner, onClose, onEdit }) as React.ReactElement<any>;
  state.mockRestore();
  ref.mockRestore();
  effect.mockRestore();
  const elements: React.ReactElement<any>[] = [];
  const walk = (node: React.ReactNode) => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const element = child as React.ReactElement<any>;
      elements.push(element);
      walk(element.props.children);
    });
  };
  walk(tree);
  const button = (label: string) =>
    elements.find(
      (element) =>
        element.type === ('Pressable' as any) && element.props.children?.props?.children === label,
    );
  return { tree, elements, button, setters, onClose, onEdit, effects };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockPlatform.OS = 'ios';
  mockOperation.data = undefined;
  mockPost.mockResolvedValue({ state: 'LOCAL' });
  mockDelete.mockResolvedValue({});
  mockGet.mockResolvedValue(native);
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

it('dismisses the iOS actions modal before opening the editor', () => {
  const f = draw(native, 'menu', true);
  f.button('comments:editComment')!.props.onPress();
  expect(f.setters[0]).toHaveBeenCalledWith(false);
  expect(f.onEdit).not.toHaveBeenCalled();
  expect(f.onClose).not.toHaveBeenCalled();
  f.tree.props.onDismiss();
  expect(f.onClose).toHaveBeenCalledTimes(1);
  expect(f.onEdit).toHaveBeenCalledWith(native);
});
it('uses the same close/edit flow on web without waiting for an iOS-only callback', () => {
  mockPlatform.OS = 'web';
  const f = draw(native, 'menu', true);
  f.button('comments:editComment')!.props.onPress();
  expect(f.setters[0]).toHaveBeenCalledWith(false);
  expect(f.onEdit).toHaveBeenCalledWith(native);
});
it.each(['report', 'reportImage', 'block', 'delete'])(
  'keeps the %s step inside exactly one modal',
  (step) => {
    const f = draw({ ...native, image: { id: 'image', status: 'ready' } }, step);
    expect(f.elements.filter((element) => element.type === ('Modal' as any))).toHaveLength(1);
    expect(f.button('common:back')).toBeDefined();
    f.button('common:back')!.props.onPress();
    expect(f.setters[1]).toHaveBeenCalledWith('menu');
    expect(mockPost).not.toHaveBeenCalled();
  },
);
it('sends local reports to the existing local route and provider reports with explicit conversation context', async () => {
  const local = draw(native, 'report');
  local.button('comments:reportSpam')!.props.onPress();
  await flush();
  expect(mockPost).toHaveBeenLastCalledWith('/comments/local-comment/report', { reason: 'SPAM' });
  const shared = draw(remote, 'report');
  shared.button('comments:reportSpam')!.props.onPress();
  await flush();
  expect(mockPost).toHaveBeenLastCalledWith(
    '/conversations/comments/11111111-1111-4111-8111-111111111111/actions?threadType=MOVIE&threadId=movie%26other',
    { action: 'report', actionId: 'test-action-id', reason: 'spam' },
  );
});
it('confirms a local deletion before invoking the existing deletion mutation', async () => {
  const menu = draw(native, 'menu', true);
  menu.button('comments:deleteComment')!.props.onPress();
  expect(mockDelete).not.toHaveBeenCalled();
  expect(menu.setters[1]).toHaveBeenCalledWith('delete');
  const confirm = draw(native, 'delete', true);
  confirm.button('comments:deleteComment')!.props.onPress();
  await flush();
  expect(mockDelete).toHaveBeenCalledWith('local-comment');
  expect(mockPost).not.toHaveBeenCalled();
});
it('keeps failures inline and does not open another modal', async () => {
  mockPost.mockRejectedValue(Error('offline'));
  const f = draw(native, 'report');
  f.button('comments:reportSpam')!.props.onPress();
  await flush();
  expect(f.setters[3]).toHaveBeenLastCalledWith('comments:failedToReport');
  expect(f.onClose).not.toHaveBeenCalled();
});
it('hides unsupported provider actions while allowing owners to edit saved local rows', () => {
  const f = draw(remote);
  expect(f.button('comments:editComment')).toBeUndefined();
  expect(f.button('comments:deleteComment')).toBeUndefined();
  expect(f.button('comments:reportSpoiler')).toBeUndefined();
  const queued = draw({ ...native, commsUniState: 'PENDING' }, 'menu', true);
  expect(queued.button('comments:editComment')).toBeDefined();
});

it.each([
  ['SYNCED', 'reportSubmitted'],
  ['DUPLICATE_REPORT', 'duplicateReport'],
  ['FAILED', 'failed'],
])('shows the final %s outcome within the existing modal', (state, key) => {
  mockOperation.data = { id: 'operation', state, reason: null };
  const f = draw(remote, 'done', false, { id: 'operation', state: 'PENDING', action: 'report' });
  f.effects[1]();
  expect(f.elements.some((element) => element.props.children === 'comments:commsuni.' + key)).toBe(
    true,
  );
  expect(f.elements.filter((element) => element.type === ('Modal' as any))).toHaveLength(1);
});
it('retains the operation ID instead of immediately refetching a queued shared report', async () => {
  mockPost.mockResolvedValue({ state: 'PENDING', operationId: 'operation' });
  const f = draw(remote, 'report');
  f.button('comments:reportSpam')!.props.onPress();
  await flush();
  expect(f.setters[4]).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'operation', action: 'report' }),
  );
  expect(mockCache.resetQueries).not.toHaveBeenCalled();
});

it.each([
  ['mine_hide', 'reportMineHide'],
  ['mine_claim', 'reportMineClaim'],
])('submits %s only for an archived TV Time comment', async (reason, key) => {
  const archived = {
    ...remote,
    shared: {
      ...remote.shared!,
      comment: {
        ...remote.shared!.comment,
        origin: { kind: 'tvtime' as const, slug: 'tvtime', displayName: 'TV Time', iconUrl: null },
      },
    },
  };
  const f = draw(archived, 'report');
  expect(
    f.elements.some(
      (element) => element.props.children === 'comments:commsuni.ownershipReportHint',
    ),
  ).toBe(true);
  f.button('comments:commsuni.' + key)!.props.onPress();
  await flush();
  expect(mockPost).toHaveBeenLastCalledWith(expect.stringContaining('/actions?'), {
    action: 'report',
    actionId: 'test-action-id',
    reason,
  });
  for (const comment of [native, remote]) {
    const other = draw(comment, 'report');
    expect(other.button('comments:commsuni.' + key)).toBeUndefined();
  }
});

it('keeps an acknowledged report visible even if cache invalidation finishes afterward', async () => {
  let release!: () => void;
  mockCache.invalidateQueries.mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  mockPost.mockResolvedValue({ state: 'PENDING', operationId: 'operation' });
  const submitting = draw(remote, 'report');
  submitting.button('comments:reportSpam')!.props.onPress();
  await flush();
  const delivery = submitting.setters[4].mock.calls.find(
    ([value]: any[]) => value?.id === 'operation',
  )![0];
  mockOperation.data = { id: 'operation', state: 'SYNCED' };
  const completed = draw(remote, 'done', false, delivery);
  expect(
    completed.elements.some(
      (element) => element.props.children === 'comments:commsuni.reportSubmitted',
    ),
  ).toBe(true);
  release();
  await flush();
  // Rendering is derived from the operation even though execute() finishes with its old response.
  const afterInvalidation = draw(remote, 'done', false, delivery);
  expect(
    afterInvalidation.elements.some(
      (element) => element.props.children === 'comments:commsuni.reportSubmitted',
    ),
  ).toBe(true);
  expect(
    afterInvalidation.elements.some(
      (element) => element.props.children === 'comments:commsuni.pending',
    ),
  ).toBe(false);
});

const ownedShared = {
  ...remote,
  shared: {
    ...remote.shared!,
    comment: {
      ...remote.shared!.comment,
      localCommentId: native.id,
      actions: { ...remote.shared!.comment.actions, delete: true },
    },
  },
};
it('gives shared owners Edit/Delete without Report/Block even when the caller used a remote author ID', () => {
  const f = draw(ownedShared, 'menu', false);
  expect(f.button('comments:editComment')).toBeDefined();
  expect(f.button('comments:deleteComment')).toBeDefined();
  expect(f.button('comments:reportComment')).toBeUndefined();
  expect(f.button('comments:blockUser')).toBeUndefined();
});
it('loads the verified local copy before editing and dismisses the iOS menu first', async () => {
  const f = draw(ownedShared);
  f.button('comments:editComment')!.props.onPress();
  await flush();
  expect(mockGet).toHaveBeenCalledWith('/comments/local-comment');
  expect(f.onEdit).not.toHaveBeenCalled();
  f.tree.props.onDismiss();
  expect(f.onEdit).toHaveBeenCalledWith(native);
});
it('deletes an owned shared comment through its verified local ID', async () => {
  const f = draw(ownedShared, 'delete');
  f.button('comments:deleteComment')!.props.onPress();
  await flush();
  expect(mockDelete).toHaveBeenCalledWith('local-comment');
  expect(mockPost).not.toHaveBeenCalled();
});
it('does not show waiting text or wait for cache refresh after a report is saved', async () => {
  mockCache.invalidateQueries.mockReturnValueOnce(new Promise<void>(() => undefined));
  mockPost.mockResolvedValue({ state: 'PENDING', operationId: 'op' });
  const f = draw(remote, 'report');
  f.button('comments:reportSpam')!.props.onPress();
  await flush();
  expect(f.setters[2]).toHaveBeenLastCalledWith(false);
  const pending = draw(remote, 'done', false, { id: 'op', state: 'PENDING', action: 'report' });
  expect(
    pending.elements.some((element) => element.props.children === 'comments:commsuni.pending'),
  ).toBe(false);
});
