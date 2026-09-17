import { runWithCommsUniClient } from '../common/client-capabilities';
import { createHash } from 'crypto';
import { CommsUniPublicationService } from './commsuni.publication.service';
import { CommsUniError } from './commsuni.client';
import { seal, unseal } from './commsuni.crypto';

const secret = 'test-only-secret-never-a-provider-key-123456';
const remoteId = '11111111-1111-4111-8111-111111111111';
function setup(over: Record<string, unknown> = {}) {
  const identity: any = {
    id: 'identity',
    userId: 'user',
    scope: 'scope',
    actorEncrypted: seal(secret, 'a'.repeat(64)),
    deleting: false,
    authorId: remoteId,
    profileHash: createHash('sha256')
      .update(JSON.stringify({ displayName: 'Test', avatarUrl: null }))
      .digest('hex'),
    user: { id: 'user', username: 'Test', isShadow: false, isSuspended: false, profile: null },
  };
  const row: any = {
    id: '22222222-2222-4222-8222-222222222222',
    identityId: identity.id,
    identity,
    method: 'PUT',
    path: '/comments/' + remoteId + '/like',
    payload: seal(secret, null),
    target: null,
    commentId: null,
    state: 'PENDING',
    firstAttemptAt: null,
    attempts: 0,
    sequence: 1n,
    createdAt: new Date('2026-01-01'),
    cleanup: false,
    ...over,
  };
  const prisma: any = {
    commsUniVoteReceipt: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    commsUniOutbox: {
      findUnique: jest.fn(async () => structuredClone(row)),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn(async ({ data }) => {
        Object.assign(row, data);
        return row;
      }),
      upsert: jest.fn().mockResolvedValue({}),
    },
    commsUniIdentity: {
      findUnique: jest.fn(async () => identity),
      delete: jest.fn(),
      update: jest.fn(async ({ data }) => Object.assign(identity, data)),
    },
    commsUniBinding: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    comment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(async (fn) => fn(prisma)),
  };
  const client: any = {
    writesEnabled: true,
    scope: 'scope',
    voteScope: 'scope',
    request: jest.fn().mockResolvedValue({ data: undefined, duplicateReport: false }),
    invalidate: jest.fn().mockResolvedValue(undefined),
    assertWrites: jest.fn(() => {
      if (!client.writesEnabled) throw new Error('disabled');
    }),
  };
  const target: any = {
    threadType: 'EPISODE',
    threadId: 'episode',
    entityType: 'episode',
    entityId: remoteId,
    reference: 'tvdb-123-s1e1',
    title: 'Pilot',
    showTitle: 'Show',
    fingerprint: 'verified',
  };
  const resolver: any = {
    resolve: jest.fn(async () => target),
    path: jest.fn(() => '/entities/episode/' + (target.entityId ?? target.reference)),
  };
  const reads: any = {
    engagement: jest.fn().mockResolvedValue({
      available: true,
      sections: [
        {
          kind: 'star_rating',
          options: [
            { key: 'rating:1', localValue: '1', selected: true },
            { key: 'rating:27', localValue: '2', selected: false },
          ],
        },
      ],
    }),
  };
  const config: any = {
    get: (key: string) =>
      key === 'commsuni.actorSecret'
        ? secret
        : key === 'nodeEnv'
          ? 'test'
          : key === 'commsuni.avatarHosts'
            ? ['avatars.example.test']
            : undefined,
  };
  const service = new CommsUniPublicationService(
    prisma,
    config,
    {} as any,
    client,
    resolver,
    reads,
  );
  return { service, row, prisma, client, resolver, target, reads, identity };
}

describe('durable CommsUni delivery (no HTTP transport)', () => {
  it('holds an ambiguous POST after the retry window instead of duplicating it', async () => {
    const { service, row, client } = setup({
      method: 'POST',
      firstAttemptAt: new Date(Date.now() - 24 * 3600000),
    });
    await service.dispatch(row.id);
    expect(row.state).toBe('UNCERTAIN');
    expect(client.request).not.toHaveBeenCalled();
  });
  it('retries the identical request after a lost response', async () => {
    const { service, row, client } = setup({
      method: 'POST',
      path: '/comments/' + remoteId + '/reports',
      payload: seal(secret, { reason: 'spam' }),
    });
    client.request.mockRejectedValueOnce(new CommsUniError(0, 'transport_error'));
    await service.dispatch(row.id);
    expect(row.state).toBe('RETRY');
    const first = client.request.mock.calls[0];
    const firstAttempt = row.firstAttemptAt;
    await service.dispatch(row.id);
    expect(client.request.mock.calls[1]).toEqual(first);
    expect(row.firstAttemptAt).toEqual(firstAttempt);
    expect(row.state).toBe('SYNCED');
  });
  it('retains retryable state when the provider succeeds but saving the acknowledgement fails', async () => {
    const { service, row, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce(
      new Error('local acknowledgement transaction failed'),
    );
    await service.dispatch(row.id);
    expect(row.state).toBe('RETRY');
    expect(row.errorCode).toBe('acknowledgement_not_saved');
    expect(row.firstAttemptAt).toBeInstanceOf(Date);
  });
  it('does not replay deliveries under a changed credential scope', async () => {
    const { service, row, client } = setup();
    client.scope = 'new-key-scope';
    await service.dispatch(row.id);
    expect(client.request).not.toHaveBeenCalled();
    expect(row.state).toBe('PENDING');
  });
  it('stops at the last gate if writes are switched off during resolution', async () => {
    const { service, row, client, resolver, target } = setup({
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    resolver.resolve.mockImplementation(async () => {
      client.writesEnabled = false;
      return target;
    });
    await service.dispatch(row.id);
    expect(client.request).not.toHaveBeenCalled();
  });
  it('serializes a single-choice replacement as clear previous, then set selected', async () => {
    const { service, row, client } = setup({
      method: 'LOCAL_VOTE',
      payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    await service.dispatch(row.id);
    expect(client.request.mock.calls.map((call: any[]) => [call[1], call[4]])).toEqual([
      ['DELETE', { optionKey: 'rating:1' }],
      ['PUT', { optionKey: 'rating:27' }],
    ]);
    expect(row.state).toBe('SYNCED');
  });
  it('uses only verified fixed poll keys for a new, unarchived entity', async () => {
    const { service, row, client, target, reads } = setup({
      method: 'LOCAL_VOTE',
      payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    target.entityId = null;
    reads.engagement.mockResolvedValue({ sections: [] });
    await service.dispatch(row.id);
    expect(client.request.mock.calls[0][2]).toBe(
      '/entities/episode/tvdb-123-s1e1/engagement/star_rating',
    );
    expect(client.request.mock.calls[0][4]).toEqual({
      optionKey: 'rating:27',
      entity: { title: 'Pilot', showTitle: 'Show' },
    });
  });
  it('holds an unverified character mapping instead of writing a local cast ID', async () => {
    const { service, row, client } = setup({
      method: 'LOCAL_VOTE',
      payload: seal(secret, { kind: 'cast_vote', value: 'local-cast-id', selected: true }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    await service.dispatch(row.id);
    expect(row.state).toBe('BLOCKED_OPTION');
    expect(client.request).not.toHaveBeenCalled();
  });
  it('pauses cleanup too when the global write gate is off', async () => {
    const { service, row, client } = setup({ cleanup: true, method: 'DELETE', payload: '' });
    client.writesEnabled = false;
    await service.dispatch(row.id);
    expect(client.request).not.toHaveBeenCalled();
    expect(row.state).toBe('PENDING');
  });
});

describe('review regressions', () => {
  function commentSetup(parentState?: string) {
    const f = setup({
      method: 'POST',
      path: '/pending',
      commentId: 'child',
      payload: seal(secret, { text: 'Reply', createdAt: '2026-01-01T00:00:00Z' }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    const child: any = {
      id: 'child',
      source: 'MANUAL',
      sourceKey: null,
      commsUniOriginId: 'child',
      parentId: parentState ? 'parent' : null,
    };
    f.prisma.comment.findUnique = jest.fn(async ({ where }) =>
      where.id === 'child'
        ? child
        : {
            id: 'parent',
            commsUniState: parentState,
            commsUniCommentId: null,
          },
    );
    f.prisma.commsUniBinding = { updateMany: jest.fn().mockResolvedValue({ count: 1 }) };
    f.client.request.mockImplementation(async (_actor: string, _method: string, path: string) => ({
      data:
        path === '/authors/me/profile'
          ? { authorId: remoteId }
          : {
              comment: { id: remoteId, entityId: remoteId, userId: remoteId },
            },
      duplicateReport: false,
    }));
    return { ...f, child };
  }

  it.each(['FAILED', 'CANCELED', 'BLOCKED_MAPPING', 'UNCERTAIN'])(
    'parks a reply to a %s parent so unrelated later writes can proceed',
    async (state) => {
      const f = commentSetup(state);
      await f.service.dispatch(f.row.id);
      expect(f.row.state).toBe('BLOCKED_PARENT');
      expect(f.client.request).not.toHaveBeenCalled();
      f.row.commentId = null;
      f.row.method = 'PUT';
      f.row.path = '/comments/' + remoteId + '/like';
      f.row.target = null;
      f.row.state = 'PENDING';
      f.row.payload = seal(secret, null);
      await f.service.dispatch(f.row.id);
      expect(f.row.state).toBe('SYNCED');
    },
  );

  it('promotes a negative mapping after the first comment write', async () => {
    const f = commentSetup();
    f.target.entityId = null;
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(f.prisma.commsUniBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ fingerprint: 'verified', entityId: null }),
        data: expect.objectContaining({ entityId: remoteId }),
      }),
    );
  });

  it('sends the TVWatch display name and approved avatar before a shared comment', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.identity.authorId = null;
    f.identity.user.profile = {
      displayName: 'Alice',
      avatarUrl: 'https://avatars.example.test/alice.png',
    };
    await f.service.dispatch(f.row.id);
    expect(f.client.request.mock.calls.map((call: any[]) => call[2])).toEqual([
      '/authors/me/profile',
      '/entities/episode/' + remoteId + '/comments',
    ]);
    expect(f.client.request.mock.calls[0]).toEqual([
      'a'.repeat(64),
      'PUT',
      '/authors/me/profile',
      {},
      { displayName: 'Alice', avatarUrl: 'https://avatars.example.test/alice.png' },
    ]);
    expect(f.identity.authorId).toBe(remoteId);
    expect(f.row.state).toBe('SYNCED');
  });

  it.each([
    'https://unapproved.example.test/avatar.png',
    'http://avatars.example.test/avatar.png',
    'https://name:password@avatars.example.test/avatar.png',
    null,
  ])('keeps the username while omitting an unsupported avatar: %s', async (avatarUrl) => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.identity.user.profile = { displayName: '', avatarUrl };
    await f.service.dispatch(f.row.id);
    expect(f.client.request.mock.calls[0][4]).toEqual({ displayName: 'Test', avatarUrl: null });
    expect(f.row.state).toBe('SYNCED');
  });

  it('skips unchanged profiles and sends a new name on a later comment', async () => {
    const f = commentSetup();
    await f.service.dispatch(f.row.id);
    expect(
      f.client.request.mock.calls.some((call: any[]) => call[2] === '/authors/me/profile'),
    ).toBe(false);
    f.identity.user.profile = { displayName: 'New name', avatarUrl: null };
    Object.assign(f.row, { state: 'PENDING', firstAttemptAt: null });
    f.client.request.mockClear();
    await f.service.dispatch(f.row.id);
    expect(f.client.request.mock.calls[0][4]).toEqual({ displayName: 'New name', avatarUrl: null });
  });

  it('retries a failed profile PUT without sending the comment or changing its identity', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.client.request.mockRejectedValueOnce(new CommsUniError(503, 'archive_writes_maintenance'));
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('RETRY');
    expect(f.row.firstAttemptAt).toBeNull();
    expect(f.client.request).toHaveBeenCalledTimes(1);
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(f.client.request.mock.calls[0]).toEqual(f.client.request.mock.calls[1]);
  });

  it('rejects a profile acknowledgement that changes a previously bound author ID', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.client.request.mockResolvedValue({
      data: { authorId: '99999999-9999-4999-8999-999999999999' },
    });
    await f.service.dispatch(f.row.id);
    expect(f.row.errorCode).toBe('profile_identity_mismatch');
    expect(f.identity.authorId).toBe(remoteId);
    expect(f.client.request).toHaveBeenCalledTimes(1);
  });

  it('retries a profile whose local acknowledgement failed without posting prematurely', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.prisma.commsUniIdentity.update.mockRejectedValueOnce(
      new Error('Database acknowledgement failed'),
    );
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('RETRY');
    expect(f.row.errorCode).toBe('profile_acknowledgement_not_saved');
    expect(f.row.firstAttemptAt).toBeNull();
    expect(f.client.request).toHaveBeenCalledTimes(1);
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(f.client.request.mock.calls[0]).toEqual(f.client.request.mock.calls[1]);
  });

  it('keeps the synchronized profile and identical comment request on a comment retry', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    let firstPost = true;
    f.client.request.mockImplementation(async (_actor: string, _method: string, path: string) => {
      if (path === '/authors/me/profile') return { data: { authorId: remoteId } };
      if (firstPost) {
        firstPost = false;
        throw new CommsUniError(0, 'transport_error');
      }
      return { data: { comment: { id: remoteId, entityId: remoteId, userId: remoteId } } };
    });
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('RETRY');
    const first = f.client.request.mock.calls[1];
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(f.client.request.mock.calls.map((call: any[]) => call[2])).toEqual([
      '/authors/me/profile',
      first[2],
      first[2],
    ]);
    expect(f.client.request.mock.calls[2]).toEqual(first);
  });

  it.each(['disabled', 'suspended', 'deleting'])(
    'sends no profile or comment while %s',
    async (mode) => {
      const f = commentSetup();
      f.identity.profileHash = null;
      if (mode === 'disabled') f.client.writesEnabled = false;
      if (mode === 'suspended') f.identity.user.isSuspended = true;
      if (mode === 'deleting') f.identity.deleting = true;
      await f.service.dispatch(f.row.id);
      expect(f.client.request).not.toHaveBeenCalled();
    },
  );

  it('rechecks the write switch after profile synchronization before sending the comment', async () => {
    const f = commentSetup();
    f.identity.profileHash = null;
    f.client.request.mockImplementation(async () => {
      f.client.writesEnabled = false;
      return { data: { authorId: remoteId } };
    });
    await f.service.dispatch(f.row.id);
    expect(f.client.request).toHaveBeenCalledTimes(1);
    expect(f.client.request.mock.calls[0][2]).toBe('/authors/me/profile');
  });

  it('resolves queued shared selections against current state at dispatch', async () => {
    const f = setup({
      method: 'SELECTION',
      path: '/entities/episode/' + remoteId + '/engagement/star_rating',
      payload: seal(secret, {
        intent: { kind: 'star_rating', optionKey: 'rating:28', selected: true },
        requests: [
          { method: 'DELETE', body: { optionKey: 'rating:1' } },
          { method: 'PUT', body: { optionKey: 'rating:28' } },
        ],
      }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    f.reads.engagement.mockResolvedValue({
      sections: [
        {
          kind: 'star_rating',
          options: [
            { key: 'rating:1', selected: false },
            { key: 'rating:27', selected: true },
            { key: 'rating:28', selected: false },
          ],
        },
      ],
    });
    await f.service.dispatch(f.row.id);
    expect(f.client.request.mock.calls.map((call: any[]) => [call[1], call[4]])).toEqual([
      ['DELETE', { optionKey: 'rating:27' }],
      ['PUT', { optionKey: 'rating:28' }],
    ]);
  });
});

describe('serialized selections and replay boundaries', () => {
  const stored = { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' };
  const payload = (key: string) =>
    seal(secret, { intent: { kind: 'star_rating', optionKey: key, selected: true } });
  it('ends at only 3 after rapid 1 -> 2 -> 3, even when every provider read still says 1', async () => {
    const f = setup({
      method: 'SELECTION',
      target: stored,
      path: '/entities/episode/' + remoteId + '/engagement/star_rating',
      payload: payload('rating:27'),
    });
    const selected = new Set(['rating:1']);
    let latest: any = null;
    f.prisma.commsUniOutbox.findFirst.mockImplementation(async () => latest);
    f.reads.engagement.mockResolvedValue({
      sections: [
        {
          kind: 'star_rating',
          options: [
            { key: 'rating:1', selected: true },
            { key: 'rating:27', selected: false },
            { key: 'rating:28', selected: false },
          ],
        },
      ],
    });
    f.client.request.mockImplementation(
      async (_actor: string, method: string, _path: string, _query: unknown, body: any) => {
        if (method === 'PUT') selected.add(body.optionKey);
        else selected.delete(body.optionKey);
        return { data: undefined };
      },
    );
    await f.service.dispatch(f.row.id);
    latest = structuredClone(f.row);
    Object.assign(f.row, {
      id: '33333333-3333-4333-8333-333333333333',
      sequence: 2n,
      state: 'PENDING',
      firstAttemptAt: null,
      payload: payload('rating:28'),
    });
    await f.service.dispatch(f.row.id);
    expect([...selected]).toEqual(['rating:28']);
    expect(f.client.request.mock.calls.map((call: any[]) => [call[1], call[4].optionKey])).toEqual([
      ['DELETE', 'rating:1'],
      ['PUT', 'rating:27'],
      ['DELETE', 'rating:27'],
      ['PUT', 'rating:28'],
    ]);
  });
  it('replays the frozen selection sequence after a partially successful delivery', async () => {
    const f = setup({
      method: 'SELECTION',
      target: stored,
      path: '/entities/episode/' + remoteId + '/engagement/star_rating',
      payload: payload('rating:27'),
    });
    f.client.request
      .mockResolvedValueOnce({ data: undefined })
      .mockRejectedValueOnce(new CommsUniError(0, 'transport_error'));
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('RETRY');
    const calls = [...f.client.request.mock.calls];
    f.reads.engagement.mockRejectedValue(new Error('Should not resolve again on retry'));
    f.client.request.mockResolvedValue({ data: undefined });
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(f.client.request.mock.calls.slice(2)).toEqual(calls.slice(1));
    expect(f.reads.engagement).toHaveBeenCalledTimes(1);
  });
  it('orders even same-millisecond operations using the database sequence', async () => {
    const f = setup({ sequence: 5n });
    f.prisma.commsUniOutbox.count.mockImplementation(async ({ where }: any) =>
      where.sequence.lt === 5n ? 1 : 0,
    );
    await f.service.dispatch(f.row.id);
    expect(f.client.request).not.toHaveBeenCalled();
  });
  it('expires a missing binding after engagement creates the first entity with a 204 response', async () => {
    const f = setup({
      method: 'LOCAL_VOTE',
      target: stored,
      payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    });
    f.target.entityId = null;
    f.reads.engagement.mockResolvedValue({ sections: [] });
    await f.service.dispatch(f.row.id);
    expect(f.prisma.commsUniBinding.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { verifiedAt: new Date(0) },
      }),
    );
  });
});

describe('reply mentions and dependencies', () => {
  it('keeps a queued reply waiting without occupying the active FIFO after an attachment delay', async () => {
    const f = setup({
      method: 'POST',
      commentId: 'child',
      payload: seal(secret, { text: 'Reply', createdAt: '2026-01-01T00:00:00Z' }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    f.prisma.comment.findUnique = jest.fn(async ({ where }) =>
      where.id === 'child'
        ? { id: 'child', source: 'MANUAL', commsUniOriginId: 'child', parentId: 'parent' }
        : { id: 'parent', commsUniState: 'WAITING_ATTACHMENT' },
    );
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('WAITING_PARENT');
    expect(f.row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(f.client.request).not.toHaveBeenCalled();
  });
  it('sends validated spans for the actual parent author and freezes them across retries', async () => {
    const mention = { authorId: remoteId, start: 0, end: 6, text: '@Alice' };
    const f = setup({
      method: 'POST',
      commentId: 'child',
      path: '/pending',
      payload: seal(secret, {
        text: '@Alice Hello',
        mentions: [mention],
        createdAt: '2026-01-01T00:00:00Z',
      }),
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    });
    f.prisma.comment.findUnique = jest.fn(async () => ({
      id: 'child',
      source: 'MANUAL',
      commsUniOriginId: 'child',
      commsUniParentId: remoteId,
    }));
    f.reads.comment = jest.fn().mockResolvedValue({
      id: remoteId,
      author: { id: remoteId },
      entityId: remoteId,
      createdAt: '2025-01-01T00:00:00Z',
      actions: { reply: true },
    });
    f.client.request
      .mockRejectedValueOnce(new CommsUniError(0, 'transport_error'))
      .mockResolvedValue({
        data: { comment: { id: remoteId, entityId: remoteId, userId: remoteId } },
      });
    await f.service.dispatch(f.row.id);
    const first = f.client.request.mock.calls[0];
    expect(first[4].mentions).toEqual([mention]);
    await f.service.dispatch(f.row.id);
    expect(f.client.request.mock.calls[1]).toEqual(first);
    expect(f.reads.comment).toHaveBeenCalledTimes(1);
    expect(f.row.state).toBe('SYNCED');
  });
});

it('resumes a prepared native vote after a crash before its first HTTP attempt', async () => {
  const f = setup({
    method: 'SELECTION',
    path: '/entities/episode/' + remoteId + '/engagement/star_rating',
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    payload: seal(secret, {
      intent: { kind: 'star_rating', value: '2', selected: true },
      requests: [],
    }),
  });
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('SYNCED');
  expect(f.client.request.mock.calls.map((call: any[]) => [call[1], call[4].optionKey])).toEqual([
    ['DELETE', 'rating:1'],
    ['PUT', 'rating:27'],
  ]);
});

it.each([false, true])(
  'captures accepted local content without an extra approval gate (attachment pending=%s)',
  async (attachmentPending) => {
    const f = setup();
    f.prisma.user = { findUnique: jest.fn().mockResolvedValue(f.identity.user) };
    f.prisma.mediaItem = {
      findUnique: jest.fn().mockResolvedValue({ type: 'SHOW', externalIds: [], show: {} }),
    };
    f.prisma.commsUniOutbox.create = jest.fn().mockResolvedValue({});
    f.prisma.comment.update = jest.fn().mockResolvedValue({});
    const comment: any = {
      id: 'new-comment',
      userId: 'user',
      source: 'MANUAL',
      sourceKey: null,
      threadType: 'SHOW',
      threadId: 'media',
      body: 'checked text',
      isSpoiler: false,
      createdAt: new Date(),
    };
    await f.service.capture(f.prisma, 'user', comment, attachmentPending);
    const operation = f.prisma.commsUniOutbox.create.mock.calls[0][0].data;
    expect(operation.target).not.toHaveProperty('moderationApproved');
    expect(operation.state).toBe(attachmentPending ? 'WAITING_ATTACHMENT' : 'PENDING');
  },
);

it('stores the acknowledged local selection atomically with a successful delivery', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    path: '/pending-engagement/star_rating',
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('SYNCED');
  expect(f.prisma.commsUniVoteReceipt.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: expect.objectContaining({
        scope: 'scope',
        kind: 'star_rating',
        reference: 'tvdb-123-s1e1',
        selectedKeys: ['rating:27'],
        sequence: 1n,
      }),
    }),
  );
});
it('makes no provider mutation and stays retryable when receipt storage is unavailable', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    path: '/pending-engagement/star_rating',
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.prisma.commsUniVoteReceipt.findFirst.mockRejectedValue({ code: 'P2021' });
  await f.service.dispatch(f.row.id);
  expect(f.client.request).not.toHaveBeenCalled();
  expect(f.row).toMatchObject({
    state: 'RETRY',
    errorCode: 'vote_receipt_storage_unavailable',
    firstAttemptAt: null,
  });
});
it('retries an acknowledged provider selection when saving its receipt fails', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    path: '/pending-engagement/star_rating',
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.prisma.commsUniVoteReceipt.upsert.mockRejectedValueOnce(Error('database unavailable'));
  await f.service.dispatch(f.row.id);
  expect(f.row).toMatchObject({ state: 'RETRY', errorCode: 'acknowledgement_not_saved' });
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('SYNCED');
  expect(f.prisma.commsUniVoteReceipt.upsert).toHaveBeenCalledTimes(2);
});
it('clears all cast aliases before changing to another verified credit', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    path: '/pending-engagement/cast_vote',
    payload: seal(secret, { kind: 'cast_vote', value: 'credit-b', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.reads.engagement.mockResolvedValue({
    available: true,
    sections: [
      {
        kind: 'cast_vote',
        options: [
          { key: 'actor:11', localValue: 'credit-a', selected: true },
          { key: 'cast:old-alias', localValue: 'credit-a', selected: true },
          { key: 'cast:new-alias', localValue: 'credit-b', selected: false },
          { key: 'actor:22', localValue: 'credit-b', selected: false },
        ],
      },
    ],
  });
  await f.service.dispatch(f.row.id);
  expect(f.client.request.mock.calls.map((args: any[]) => [args[1], args[4].optionKey])).toEqual([
    ['DELETE', 'actor:11'],
    ['DELETE', 'cast:old-alias'],
    ['PUT', 'actor:22'],
  ]);
  expect(f.row.state).toBe('SYNCED');
});

it('applies a generic local selection and its enqueue once for a repeated action ID', async () => {
  const f = setup();
  f.prisma.user = {
    findUnique: jest.fn().mockResolvedValue({ id: 'user', isShadow: false, isSuspended: false }),
  };
  let operation: any = null;
  f.prisma.commsUniOutbox.findUnique.mockImplementation(async () => operation);
  f.prisma.commsUniOutbox.create = jest.fn(async ({ data }) => {
    operation = { id: 'queued', ...data };
    return operation;
  });
  const change = jest.fn().mockResolvedValue(undefined);
  const body = { intent: { kind: 'star_rating', value: '2', selected: true } };
  const target = { threadType: 'EPISODE' as const, threadId: 'episode', fingerprint: 'verified' };
  await f.service.enqueue(
    'user',
    'SELECTION',
    '/entities/episode/entity/engagement/star_rating',
    body,
    f.row.id,
    target,
    false,
    change,
  );
  await f.service.enqueue(
    'user',
    'SELECTION',
    '/entities/episode/entity/engagement/star_rating',
    body,
    f.row.id,
    target,
    false,
    change,
  );
  expect(change).toHaveBeenCalledTimes(1);
  expect(f.prisma.commsUniOutbox.create).toHaveBeenCalledTimes(1);
  expect(f.client.request).not.toHaveBeenCalled();
});

it('does not use a fixed star key to override contradictory provider catalog identity', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    path: '/pending-engagement/star_rating',
    payload: seal(secret, { kind: 'star_rating', value: '4', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.reads.engagement.mockResolvedValue({
    available: true,
    sections: [
      { kind: 'star_rating', options: [{ key: 'rating:29', localValue: null, selected: false }] },
    ],
  });
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('BLOCKED_OPTION');
  expect(f.client.request).not.toHaveBeenCalled();
});

it.each([{ reference: 'tvdb-999-s1e1' }, { entityId: '99999999-9999-4999-8999-999999999999' }])(
  'blocks a queued action when the resolved provider target changes: %j',
  async (changed) => {
    const f = setup({
      target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified', ...changed },
    });
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('BLOCKED_MAPPING');
    expect(f.client.request).not.toHaveBeenCalled();
  },
);

describe('backfill and imported-parent safeguards', () => {
  it.each(['tvtime|' + remoteId, 'tvtime|cid:123'])(
    'references only verified-form original UUIDs: %s',
    async (sourceKey) => {
      const f = setup();
      f.prisma.user = { findUnique: jest.fn().mockResolvedValue(f.identity.user) };
      f.prisma.mediaItem = {
        findUnique: jest.fn().mockResolvedValue({ type: 'SHOW', externalIds: [], show: {} }),
      };
      f.prisma.comment.findUnique = jest
        .fn()
        .mockResolvedValue({ id: 'parent', source: 'TVTIME', sourceKey });
      f.prisma.comment.update = jest.fn();
      f.prisma.commsUniOutbox.create = jest.fn();
      const comment: any = {
        id: 'child',
        userId: 'user',
        source: 'MANUAL',
        parentId: 'parent',
        threadType: 'SHOW',
        threadId: 'media',
        body: 'Original reply',
        createdAt: new Date(),
        isSpoiler: false,
      };
      await f.service.capture(f.prisma, 'user', comment, false);
      if (sourceKey.includes('cid:')) {
        expect(f.prisma.commsUniOutbox.create).not.toHaveBeenCalled();
      } else {
        expect(comment.commsUniParentId).toBe(remoteId);
        expect(f.prisma.commsUniOutbox.create.mock.calls[0][0].data).toMatchObject({
          commentId: 'child',
          target: { notifyOnDelivery: false },
        });
      }
      expect(f.client.request).not.toHaveBeenCalled();
    },
  );
  it('parks historical work while the separate backfill switch is off', async () => {
    const f = setup({ target: { backfill: { runId: remoteId } } });
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('BACKFILL_PAUSED');
    expect(f.client.request).not.toHaveBeenCalled();
  });
  it.each([{ notifyOnDelivery: false }, { backfill: { runId: remoteId } }])(
    'suppresses duplicate or historical reply notifications: %j',
    async (target) => {
      const f = setup({
        method: 'POST',
        path: '/comments/' + remoteId + '/replies',
        target,
        payload: seal(secret, { text: 'Reply' }),
      });
      const get = (f.service as any).config.get;
      (f.service as any).config.get = (key: string) =>
        key === 'commsuni.backfillEnabled' ? true : get(key);
      const events = { emit: jest.fn() };
      (f.service as any).events = events;
      await f.service.dispatch(f.row.id);
      expect(f.row.state).toBe('SYNCED');
      expect(events.emit).not.toHaveBeenCalled();
    },
  );
  it('retains encrypted provider diagnostics while leaving the destination intact', async () => {
    const f = setup({
      target: {
        threadType: 'EPISODE',
        threadId: 'episode',
        fingerprint: 'verified',
        reference: 'tvdb-123-s1e1',
      },
    });
    f.client.request.mockRejectedValue(
      new CommsUniError(429, 'quota_exceeded', 'daily_budget', 60, 'request-id', 'Detailed reason'),
    );
    await f.service.dispatch(f.row.id);
    expect(f.row.target.reference).toBe('tvdb-123-s1e1');
    expect(JSON.stringify(f.row.target)).not.toContain('Detailed reason');
    expect(unseal(secret, f.row.target.lastError.messageEncrypted)).toBe('Detailed reason');
  });
});

it.each([false, true])(
  'keeps the uncertainty clock only if an earlier POST might have succeeded (%s)',
  async (prior) => {
    const firstAttemptAt = prior ? new Date(Date.now() - 1000) : null;
    const f = setup({
      method: 'POST',
      path: '/comments/' + remoteId + '/reports',
      firstAttemptAt,
      payload: seal(secret, { reason: 'spam' }),
    });
    f.client.request.mockRejectedValue(new CommsUniError(429, 'quota_exceeded', 'daily_budget'));
    await f.service.dispatch(f.row.id);
    expect(f.row.firstAttemptAt).toEqual(firstAttemptAt);
    expect(f.row.state).toBe('RETRY');
  },
);

it('preserves selection progress when the second step hits a quota limit', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
  });
  f.client.request
    .mockResolvedValueOnce({ data: undefined })
    .mockRejectedValueOnce(new CommsUniError(429, 'quota_exceeded', 'actor_rate', 1));
  await f.service.dispatch(f.row.id);
  expect(f.row.firstAttemptAt).toBeInstanceOf(Date);
  expect(unseal<any>(secret, f.row.payload).nextRequest).toBe(1);
  f.client.request.mockResolvedValue({ data: undefined });
  await f.service.dispatch(f.row.id);
  expect(f.client.request.mock.calls.map((args: any[]) => args[1])).toEqual([
    'DELETE',
    'PUT',
    'PUT',
  ]);
  expect(f.row.state).toBe('SYNCED');
});

it('records a definite first vote rejection without poisoning community counts', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.client.request.mockRejectedValueOnce(new CommsUniError(400, 'invalid_parameter'));
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('FAILED');
  expect(f.row.target.deliveryUncertain).toBe(false);
});
it('retains uncertainty when a replacement vote partially succeeded before a rejection', async () => {
  const f = setup({
    method: 'LOCAL_VOTE',
    payload: seal(secret, { kind: 'star_rating', value: '2', selected: true }),
    target: { threadType: 'EPISODE', threadId: 'episode', fingerprint: 'verified' },
  });
  f.client.request
    .mockResolvedValueOnce({ data: undefined })
    .mockRejectedValueOnce(new CommsUniError(400, 'invalid_parameter'));
  await f.service.dispatch(f.row.id);
  expect(f.row.state).toBe('FAILED');
  expect(f.row.target.deliveryUncertain).toBe(true);
});

it.each([
  { label: 'live text', state: 'PENDING', backfill: false, gif: false },
  { label: 'live GIF', state: 'PENDING', backfill: false, gif: true },
  { label: 'historical backfill', state: 'PENDING', backfill: true, gif: false },
  {
    label: 'legacy moderation hold',
    state: 'WAITING_REVIEW',
    errorCode: 'moderation_required',
    backfill: false,
    gif: false,
  },
  {
    label: 'old moderation retry',
    state: 'RETRY',
    errorCode: 'moderation_unavailable',
    backfill: false,
    gif: false,
  },
])(
  'publishes $label without another moderation check',
  async ({ state, errorCode, backfill, gif }) => {
    const body = {
      text: 'Already stored in the app',
      createdAt: '2026-01-01T00:00:00Z',
      ...(gif
        ? {
            attachments: [
              {
                url: 'https://media.tenor.com/test/tenor.gif',
                contentType: 'image/gif',
                provider: 'external',
              },
            ],
          }
        : {}),
    };
    const f = setup({
      state,
      errorCode,
      method: 'POST',
      commentId: 'local-comment',
      payload: seal(secret, body),
      target: {
        threadType: 'EPISODE',
        threadId: 'episode',
        fingerprint: 'verified',
        ...(backfill ? { backfill: { runId: remoteId } } : {}),
      },
    });
    const originalGet = (f.service as any).config.get;
    (f.service as any).config.get = (key: string) =>
      key === 'commsuni.backfillEnabled' ? true : originalGet(key);
    const oldModerator = {
      approve: jest.fn().mockRejectedValue(new Error('must never be called')),
    };
    Object.assign(f.service, { moderation: oldModerator });
    f.prisma.comment.findUnique = jest.fn(async () => ({
      id: 'local-comment',
      source: 'MANUAL',
      commsUniOriginId: 'local-comment',
    }));
    f.client.request.mockResolvedValue({
      data: { comment: { id: remoteId, entityId: remoteId, userId: remoteId } },
    });
    await f.service.dispatch(f.row.id);
    expect(f.row.state).toBe('SYNCED');
    expect(oldModerator.approve).not.toHaveBeenCalled();
    expect(f.client.request.mock.calls[0][4]).toMatchObject(body);
  },
);

it.each([
  { mediaId: 'linked-movie', mediaType: 'MOVIE' },
  { mediaId: 'linked-show', mediaType: 'SHOW' },
  { listId: 'linked-list' },
])('keeps rich-card comments local and preserves their links: %j', async (attachment) => {
  const f = setup();
  f.prisma.commsUniOutbox.create = jest.fn();
  const comment: any = {
    id: 'card-comment',
    userId: 'user',
    source: 'MANUAL',
    threadType: 'SHOW',
    ...attachment,
  };
  await f.service.capture(f.prisma, 'user', comment, false);
  expect(comment).toMatchObject(attachment);
  expect(f.prisma.commsUniOutbox.create).not.toHaveBeenCalled();
  expect(f.client.request).not.toHaveBeenCalled();
});

it('keeps a legacy HTTP vote local with writes enabled', async () => {
  const f = setup();
  const change = jest.fn().mockResolvedValue('saved');
  await expect(
    runWithCommsUniClient(false, () =>
      f.service.voteTransaction('user', 'MOVIE', 'movie', 'star_rating', '4', true, change),
    ),
  ).resolves.toBe('saved');
  expect(change).toHaveBeenCalledWith(f.prisma);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
  expect(f.client.request).not.toHaveBeenCalled();
});
it('does not mistake the admin backfill client for an old mobile comment submission', async () => {
  const f = setup();
  f.prisma.user = { findUnique: jest.fn().mockResolvedValue(f.identity.user) };
  f.prisma.mediaItem = {
    findUnique: jest.fn().mockResolvedValue({ type: 'SHOW', externalIds: [], show: {} }),
  };
  f.prisma.comment.update = jest.fn();
  f.prisma.commsUniOutbox.create = jest.fn();
  const comment: any = {
    id: 'historical',
    userId: 'user',
    threadType: 'SHOW',
    threadId: 'media',
    source: 'MANUAL',
    body: 'Historical original',
    createdAt: new Date('2020-01-01'),
    isSpoiler: false,
  };
  await runWithCommsUniClient(false, () =>
    f.service.capture(f.prisma, 'user', comment, false, undefined, {
      runId: remoteId,
      cutoff: '2026-01-01T00:00:00Z',
    }),
  );
  expect(f.prisma.commsUniOutbox.create).toHaveBeenCalledTimes(1);
  expect(f.client.request).not.toHaveBeenCalled();
});

describe('post-commit delivery wakeups', () => {
  it('wakes reports only after the outbox transaction commits', async () => {
    const f = setup();
    f.prisma.user = { findUnique: jest.fn().mockResolvedValue(f.identity.user) };
    f.prisma.commsUniOutbox.findUnique.mockResolvedValue(null);
    f.prisma.commsUniOutbox.create = jest.fn().mockResolvedValue(f.row);
    const queue = { add: jest.fn().mockResolvedValue({}) };
    (f.service as any).queue = queue;
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => {
      commit = resolve;
    });
    f.prisma.$transaction.mockImplementation(async (action: any) => {
      const result = await action(f.prisma);
      await gate;
      return result;
    });
    const pending = f.service.enqueue(
      'user',
      'POST',
      '/comments/' + remoteId + '/reports',
      { reason: 'spam' },
      remoteId,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(queue.add).not.toHaveBeenCalled();
    commit();
    await pending;
    expect(queue.add).toHaveBeenCalledWith(
      'drain',
      {},
      { removeOnComplete: true, removeOnFail: 20 },
    );
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it('does not wake on a rolled-back action', async () => {
    const f = setup();
    f.prisma.user = { findUnique: jest.fn().mockResolvedValue(f.identity.user) };
    const queue = { add: jest.fn() };
    (f.service as any).queue = queue;
    f.prisma.$transaction.mockRejectedValue(Error('rollback'));
    await expect(
      f.service.enqueue(
        'user',
        'POST',
        '/comments/' + remoteId + '/reports',
        { reason: 'spam' },
        remoteId,
      ),
    ).rejects.toThrow('rollback');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retains committed work when Redis cannot accept an immediate wakeup', async () => {
    const f = setup();
    (f.service as any).queue = { add: jest.fn().mockRejectedValue(Error('offline')) };
    const warn = jest.spyOn((f.service as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(f.service.wake()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(f.prisma.commsUniOutbox.update).not.toHaveBeenCalled();
  });
});
