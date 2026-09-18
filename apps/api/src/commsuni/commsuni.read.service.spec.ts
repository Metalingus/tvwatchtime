import { CommsUniReadService } from './commsuni.read.service';
const uuid = (n: number) => '11111111-1111-4111-8111-' + String(n).padStart(12, '0');
function fixture() {
  const target: any = {
    entityId: uuid(1),
    entityType: 'show',
    threadType: 'SHOW',
    threadId: 'media',
  };
  const raw = {
    id: uuid(2),
    entityId: uuid(1),
    userId: uuid(3),
    userName: 'Persona',
    origin: { kind: 'partner', slug: 'partner', displayName: 'Partner' },
  };
  const client: any = {
    scope: 'scope',
    prime: jest.fn().mockResolvedValue(undefined),
    cacheVersion: jest.fn().mockResolvedValue(0),
    writesEnabled: false,
    read: jest.fn().mockResolvedValue({ comment: raw }),
  };
  const prisma: any = {
    comment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    commsUniReport: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    commsUniAuthorBlock: { findMany: jest.fn().mockResolvedValue([]) },
    block: { findMany: jest.fn().mockResolvedValue([]) },
    commsUniIdentity: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ isSuspended: false, isShadow: false }) },
  };
  const service = new CommsUniReadService(
    client,
    { path: () => '/entities/show/' + uuid(1) } as any,
    prisma,
  );
  jest.spyOn(service, 'sources').mockResolvedValue(new Map());
  return { target, raw, client, prisma, service };
}
it('rejects a different comment even when it belongs to the same entity', async () => {
  const f = fixture();
  await expect(f.service.comment('viewer', f.target, uuid(9))).rejects.toMatchObject({
    code: 'comment_id_mismatch',
  });
});
it('does not expose a blocked author through direct comment/media verification', async () => {
  const f = fixture();
  f.prisma.commsUniAuthorBlock.findMany.mockResolvedValue([{ authorId: uuid(3) }]);
  await expect(f.service.comment('viewer', f.target, uuid(2))).rejects.toThrow('Comment not found');
});
it('allows local replies while keeping provider write actions disabled', async () => {
  const f = fixture();
  const comment = await f.service.comment('viewer', f.target, uuid(2));
  expect(comment.actions).toEqual({
    like: false,
    reply: true,
    delete: false,
    spoiler: false,
    authorSpoiler: false,
  });
});

it('keeps a native account block effective on that account’s published provider persona', async () => {
  const f = fixture();
  f.prisma.block.findMany.mockResolvedValue([{ blockedId: 'local-author' }]);
  f.prisma.commsUniIdentity.findMany.mockResolvedValue([
    { userId: 'local-author', authorId: uuid(3) },
  ]);
  await expect(f.service.comment('viewer', f.target, uuid(2))).rejects.toThrow('Comment not found');
});
it('maps a provider block to a local account only through an explicit stored publication identity', async () => {
  const f = fixture();
  f.prisma.commsUniAuthorBlock.findMany.mockResolvedValue([{ authorId: uuid(3) }]);
  f.prisma.commsUniIdentity.findMany.mockResolvedValue([
    { userId: 'local-author', authorId: uuid(3) },
  ]);
  expect((await f.service.blockedIdentities('viewer')).userIds.has('local-author')).toBe(true);
});

describe('conversation comment counts', () => {
  const linkedId = uuid(20);
  const localRow = (over: Record<string, unknown> = {}) => ({
    source: 'MANUAL',
    sourceKey: null,
    commsUniCommentId: null,
    commsUniEntityId: null,
    commsUniOriginId: null,
    commsUniState: null,
    ...over,
  });
  function setupCounts(rows: any[] = [localRow()], originals: any[] = []) {
    const target = { entityId: uuid(1), entityType: 'episode', threadId: 'episode' };
    const resolver: any = {
      resolve: jest.fn().mockResolvedValue(target),
      path: jest.fn().mockReturnValue('/entities/episode/' + uuid(1)),
    };
    const data = {
      entityId: uuid(1),
      entityType: 'episode',
      comments: { archived: 40, native: 2, total: 42 },
      replies: { archived: 800, native: 100, total: 900 },
    };
    const client: any = { enabled: true, read: jest.fn().mockResolvedValue(data) };
    const prisma: any = {
      comment: { findMany: jest.fn() },
      $queryRaw: jest.fn(async () => {
        // Reference behavior; the SQL itself is exercised against PostgreSQL in comment-count.sql.spec.
        const extras = rows.filter((row) => {
          const origin = originals.find((item) => item.id === row.commsUniOriginId);
          const shared = [row, origin].some(
            (item) => item?.commsUniEntityId === uuid(1) && !!item.commsUniCommentId,
          );
          const independent =
            row.hasLocalRevision && (!row.commsUniCommentId || row.source !== 'MANUAL');
          return !shared || independent;
        });
        return [
          {
            extra: BigInt(extras.length),
            approximate: extras.some(
              (row) =>
                !(row.hasLocalRevision && (!row.commsUniCommentId || row.source !== 'MANUAL')) &&
                ((row.source && row.source !== 'MANUAL') ||
                  row.sourceKey ||
                  ['SENDING', 'RETRY', 'SYNCED'].includes(row.commsUniState ?? '')),
            ),
          },
        ];
      }),
    };
    return {
      service: new CommsUniReadService(client, resolver, prisma),
      client,
      resolver,
      prisma,
      data,
    };
  }
  it('adds local-only posts to provider top-level totals without loading provider comments/replies', async () => {
    const f = setupCounts([localRow(), localRow()]);
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 2)).resolves.toEqual({
      total: 44,
      approximate: false,
      source: 'commsuni',
    });
    expect(f.client.read).toHaveBeenCalledTimes(1);
    expect(f.client.read).toHaveBeenCalledWith(
      'viewer',
      '/entities/episode/' + uuid(1) + '/conversation',
      {},
      0,
    );
    expect(f.prisma.comment.findMany).not.toHaveBeenCalled();
    expect(f.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('does not add directly linked shared comments or their structural copies again', async () => {
    const f = setupCounts(
      [
        localRow(),
        localRow({ commsUniCommentId: linkedId, commsUniEntityId: uuid(1) }),
        localRow({ commsUniOriginId: 'original' }),
      ],
      [{ id: 'original', commsUniCommentId: linkedId, commsUniEntityId: uuid(1) }],
    );
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 3)).resolves.toEqual({
      total: 43,
      approximate: false,
      source: 'commsuni',
    });
  });
  it('keeps unmatched imports but marks their potentially overlapping sum approximate', async () => {
    const f = setupCounts([localRow({ source: 'TVTIME', sourceKey: 'tvtime|' + linkedId })]);
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 1)).resolves.toEqual({
      total: 43,
      approximate: true,
      source: 'commsuni',
    });
  });
  it('marks an unacknowledged delivery approximate', async () => {
    const f = setupCounts([localRow({ commsUniState: 'SENDING' })]);
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 1)).resolves.toEqual({
      total: 43,
      approximate: true,
      source: 'commsuni',
    });
  });
  it('does not subtract a provider link from another entity', async () => {
    const f = setupCounts([localRow({ commsUniCommentId: linkedId, commsUniEntityId: uuid(99) })]);
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 1)).resolves.toMatchObject({
      total: 43,
    });
  });
  it.each(['unavailable', 'unmapped', 'missing'])(
    'preserves the local count if provider is %s',
    async (mode) => {
      const f = setupCounts();
      if (mode === 'unavailable') f.client.read.mockRejectedValue(new Error('timeout'));
      if (mode === 'unmapped') f.resolver.resolve.mockRejectedValue(new Error('mapping'));
      if (mode === 'missing')
        f.resolver.resolve.mockResolvedValue({ entityId: null, threadId: 'episode' });
      await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 7)).resolves.toEqual({
        total: 7,
        approximate: false,
        source: 'local',
      });
    },
  );
  it.each([
    { entityId: uuid(99) },
    { entityType: 'movie' },
    { comments: { archived: 40, native: 2, total: 41 } },
    { comments: { archived: -1, native: 0, total: -1 } },
    { comments: { archived: '40', native: 2, total: 42 } },
    { comments: {} },
  ])('rejects mismatched or malformed provider counts %j', async (changed) => {
    const f = setupCounts();
    f.client.read.mockResolvedValue({ ...f.data, ...changed });
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 7)).resolves.toEqual({
      total: 7,
      approximate: false,
      source: 'local',
    });
  });
  it('treats a valid zero count as zero, not an unavailable response', async () => {
    const f = setupCounts([]);
    f.client.read.mockResolvedValue({ ...f.data, comments: { archived: 0, native: 0, total: 0 } });
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 0)).resolves.toEqual({
      total: 0,
      approximate: false,
      source: 'commsuni',
    });
  });
  it('does not call the provider when disabled or no viewer is present', async () => {
    const f = setupCounts();
    await expect(f.service.commentCount(undefined, 'EPISODE', 'episode', 7)).resolves.toMatchObject(
      { total: 7 },
    );
    f.client.enabled = false;
    await expect(f.service.commentCount('viewer', 'EPISODE', 'episode', 7)).resolves.toMatchObject({
      total: 7,
    });
    expect(f.client.read).not.toHaveBeenCalled();
  });
});

it.each(['suspended', 'shadow', 'deleting', 'missing'])(
  'keeps replies unavailable for an ineligible %s account',
  async (mode) => {
    const f = fixture();
    if (mode === 'suspended')
      f.prisma.user.findUnique.mockResolvedValue({ isSuspended: true, isShadow: false });
    if (mode === 'shadow')
      f.prisma.user.findUnique.mockResolvedValue({ isSuspended: false, isShadow: true });
    if (mode === 'missing') f.prisma.user.findUnique.mockResolvedValue(null);
    if (mode === 'deleting')
      f.prisma.commsUniIdentity.findUnique.mockResolvedValue({ deleting: true });
    expect((await f.service.comment('viewer', f.target, uuid(2))).actions.reply).toBe(false);
  },
);
it.each([0, 1, 2])(
  'returns reply actions on depth %s list rows while provider writes are off',
  async (depth) => {
    const f = fixture();
    f.client.read.mockResolvedValue({ comments: [{ ...f.raw, depth }], complete: true });
    f.prisma.commsUniReport.findMany = jest.fn().mockResolvedValue([]);
    const page = await f.service.comments('viewer', f.target, 'LATEST');
    expect(page.comments[0].actions).toMatchObject({ reply: true, like: false });
  },
);
it('includes visible unshared replies in the count so individual messages stay expandable', async () => {
  const f = fixture();
  f.prisma.comment.groupBy.mockResolvedValue([{ commsUniParentId: uuid(2), _count: { _all: 1 } }]);
  expect((await f.service.comment('viewer', f.target, uuid(2))).replyCount).toBe(1);
  expect(f.prisma.comment.groupBy).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({
        threadType: 'SHOW',
        threadId: 'media',
        commsUniCommentId: null,
        source: 'MANUAL',
        hidden: false,
        deletedByUser: false,
      }),
    }),
  );
});

it('keeps a sanitized deleted parent expandable while withholding its content and actions', async () => {
  const f = fixture();
  Object.assign(f.raw, {
    deleted: true,
    replyCount: 3,
    text: 'must not appear',
    media: { kind: 'external', url: 'https://example.test/private.webp' },
  });
  const parent = await f.service.comment('viewer', f.target, uuid(2));
  expect(parent).toMatchObject({
    deleted: true,
    text: null,
    media: null,
    mentions: [],
    replyCount: 3,
  });
  expect(Object.values(parent.actions).every((allowed) => allowed === false)).toBe(true);
  f.client.read.mockImplementation(async (_user: string, path: string) =>
    path.endsWith('/replies')
      ? {
          replies: [
            {
              ...f.raw,
              id: uuid(4),
              deleted: false,
              replyCount: 0,
              rootCommentId: uuid(2),
              parentCommentId: uuid(2),
              media: null,
            },
          ],
          complete: true,
        }
      : { comment: f.raw },
  );
  const page = await f.service.comments('viewer', f.target, 'LATEST', undefined, uuid(2));
  expect(page.comments.map((row) => row.id)).toEqual([uuid(4)]);
});
it('refreshes only an existing own-source cache row on a user-driven read', async () => {
  const f = fixture();
  f.client.sourceSlug = 'partner';
  f.prisma.comment.updateMany = jest.fn().mockResolvedValue({ count: 1 });
  Object.assign(f.raw, { likeCount: 12, isSpoiler: true });
  await f.service.comment('viewer', f.target, uuid(2));
  expect(f.prisma.comment.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: expect.objectContaining({ commsUniCommentId: uuid(2), source: 'MANUAL' }),
      data: expect.objectContaining({ likesCount: 12, isSpoiler: true }),
    }),
  );
  f.prisma.comment.updateMany.mockClear();
  f.raw.origin.slug = 'another-partner';
  await f.service.comment('viewer', f.target, uuid(2));
  expect(f.prisma.comment.updateMany).not.toHaveBeenCalled();
});

it('exposes an editable local ID only for the signed-in owner of a verified own-source publication', async () => {
  const f = fixture();
  f.client.sourceSlug = 'tv-watch-time';
  f.raw.origin = { kind: 'partner', slug: 'tv-watch-time', displayName: 'TV Watch Time' };
  const link = {
    id: 'local-owned',
    userId: 'viewer',
    source: 'MANUAL',
    commsUniEntityId: uuid(1),
    commsUniCommentId: uuid(2),
    hidden: false,
    adminDeleted: false,
    deletedByUser: false,
  };
  f.prisma.comment.findMany.mockResolvedValue([link]);
  f.prisma.comment.updateMany = jest.fn();
  expect((await f.service.comment('viewer', f.target, uuid(2))).localCommentId).toBe('local-owned');
  link.userId = 'another-user';
  expect((await f.service.comment('viewer', f.target, uuid(2))).localCommentId).toBeUndefined();
  link.userId = 'viewer';
  link.source = 'TVTIME';
  expect((await f.service.comment('viewer', f.target, uuid(2))).localCommentId).toBeUndefined();
  link.source = 'MANUAL';
  link.commsUniEntityId = uuid(99);
  expect((await f.service.comment('viewer', f.target, uuid(2))).localCommentId).toBeUndefined();
});

it('maps ID-only provider cast rows through persisted role IDs on the verified media', async () => {
  const f = fixture();
  f.target.mediaId = 'verified-media';
  f.client.read.mockResolvedValue({
    entity: { type: 'show', id: uuid(1) },
    options: {
      castVotes: [
        {
          key: 'character:tvdb-64178863',
          provider: 'tvdb',
          characterId: '64178863',
          peopleId: '295149',
          name: null,
          role: '',
          imageUrl: null,
          count: 3,
          votes: { archived: 0, native: 3, total: 3 },
          viewerSelected: true,
        },
      ],
    },
  });
  f.prisma.mediaCast = {
    findMany: jest.fn().mockResolvedValue([
      {
        id: 'credit',
        characterExternalId: 64178863,
        character: 'Juliette',
        characterImageUrl: null,
        castMember: { name: 'Rebecca Ferguson', profileUrl: null },
      },
    ]),
  };
  const service = new CommsUniReadService(
    f.client,
    {
      resolve: jest.fn().mockResolvedValue(f.target),
      path: () => '/entities/show/' + uuid(1),
    } as any,
    f.prisma,
  );
  const result = await service.engagement('viewer', 'SHOW', 'media', false);
  expect(result.sections.find((s) => s.kind === 'cast_vote')?.options).toEqual([
    expect.objectContaining({
      key: 'character:tvdb-64178863',
      localValue: 'credit',
      label: 'Rebecca Ferguson',
      role: 'Juliette',
      count: 3,
      selected: true,
    }),
  ]);
  expect(f.prisma.mediaCast.findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { mediaId: 'verified-media' },
      select: expect.objectContaining({ characterExternalId: true }),
    }),
  );
});
