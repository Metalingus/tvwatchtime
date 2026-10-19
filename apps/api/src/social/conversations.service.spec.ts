import { ConversationsService } from './conversations.service';

const entity = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => '22222222-2222-4222-8222-' + String(n).padStart(12, '0');
const remote = (n: number, likes = 100 - n) => ({
  id: uuid(n),
  entityId: entity,
  text: 'Remote ' + n,
  createdAt: '2026-01-01T00:00:00Z',
  author: { id: uuid(999), displayName: 'Author', avatarUrl: null },
  likeCount: likes,
});
const local = (n: number, likes = n) => ({
  id: 'local-' + n,
  userId: 'user',
  body: 'Local ' + n,
  source: 'MANUAL',
  sourceKey: null,
  createdAt: new Date('2026-01-01'),
  updatedAt: new Date('2026-01-01'),
  likesCount: likes,
  commsUniCommentId: null,
  commsUniEntityId: null,
  commsUniOriginId: null,
});

function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]: [string, any]) => {
    if (key === 'AND') return condition.every((part: any) => matches(row, part));
    if (key === 'OR') return condition.some((part: any) => matches(row, part));
    if (key === 'NOT') return !matches(row, condition);
    const value = row[key] ?? null;
    if (condition instanceof Date) return +value === +condition;
    if (condition && typeof condition === 'object')
      return Object.entries(condition).every(([op, expected]: [string, any]) => {
        if (op === 'in') return expected.includes(value);
        if (op === 'notIn') return !expected.includes(value);
        if (op === 'not') return value !== expected;
        if (op === 'gt') return value > expected;
        if (op === 'lt') return value < expected;
        return true;
      });
    // Basic fixtures omit thread/visibility fields; they all belong to the requested thread.
    if (!(key in row) && ['threadType', 'threadId', 'hidden', 'adminDeleted'].includes(key))
      return true;
    return value === condition;
  });
}

function setup(locals: any[], pages: any[]) {
  const entries = new Map<string, unknown>();
  const expires = new Map<string, number>();
  const redis: any = {
    del: jest.fn(async (key) => {
      entries.delete(key);
      expires.delete(key);
    }),
    set: jest.fn(async (key, value, ttl) => {
      expires.set(key, Date.now() + ttl * 1000);
      entries.set(key, JSON.parse(JSON.stringify(value)));
    }),
    get: jest.fn(async (key) =>
      entries.has(key) && (expires.get(key) ?? 0) > Date.now()
        ? JSON.parse(JSON.stringify(entries.get(key)))
        : null,
    ),
  };
  const prisma: any = {
    block: { findMany: jest.fn().mockResolvedValue([]) },
    commsUniAuthorBlock: { findMany: jest.fn().mockResolvedValue([]) },
    commsUniReport: { findMany: jest.fn().mockResolvedValue([]) },
    comment: {
      findMany: jest.fn(async (q) => {
        if (!q.where.threadType) return [];
        const result = locals.filter((row) => matches(row, q.where));
        result.sort((a, b) => {
          for (const order of q.orderBy ?? []) {
            const [key, direction] = Object.entries(order)[0];
            const av = a[key],
              bv = b[key];
            const delta =
              av instanceof Date
                ? +av - +bv
                : typeof av === 'number'
                  ? av - bv
                  : String(av).localeCompare(String(bv));
            if (delta) return direction === 'desc' ? -delta : delta;
          }
          return 0;
        });
        return result.slice(0, q.take ?? result.length);
      }),
    },
  };
  const comments: any = {
    conversationBatch: jest.fn(async (_user, ids, shared) => ({
      comments: locals.filter(
        (row) =>
          ids.includes(row.id) ||
          (row.source === 'MANUAL' &&
            row.hasLocalRevision &&
            shared.ids.includes(row.commsUniCommentId)),
      ),
      revisions: locals
        .filter(
          (row) =>
            row.source === 'MANUAL' &&
            row.hasLocalRevision &&
            shared.ids.includes(row.commsUniCommentId),
        )
        .map((comment) => ({
          sharedId: comment.commsUniCommentId,
          comment,
          source: comment.source,
        })),
    })),
    threadContexts: jest.fn().mockResolvedValue(new Map()),
    reviewPseudoItems: jest.fn().mockResolvedValue([]),
  };
  const reviews: any = { ensureFreshForThread: jest.fn().mockResolvedValue(undefined) };
  const client: any = { enabled: true, scope: 'scope', writesEnabled: false };
  const target: any = {
    threadType: 'SHOW',
    threadId: 'media',
    entityId: entity,
    fingerprint: 'verified',
    entityType: 'show',
  };
  const resolver: any = {
    canonicalThread: jest.fn(async (_type, id) => id),
    resolve: jest.fn(async () => target),
  };
  const reads: any = {
    blockedIdentities: jest.fn(async () => ({
      authorIds: new Set(
        (await prisma.commsUniAuthorBlock.findMany()).map((row: any) => row.authorId),
      ),
      userIds: new Set((await prisma.block.findMany()).map((row: any) => row.blockedId)),
    })),
    comments: jest.fn(async (_user, _target, _sort, cursor) => pages[Number(cursor ?? '0')]),
    comment: jest.fn(async (_user, _target, id) =>
      pages.flatMap((page) => page?.comments ?? []).find((row) => row.id === id),
    ),
    commentsByIds: jest.fn(async (user, target, ids) =>
      (await Promise.all(ids.map((id: string) => reads.comment(user, target, id)))).filter(Boolean),
    ),
    archiveMembership: jest.fn(
      async (user, target, ids: string[]) =>
        new Map(
          await Promise.all(
            ids.map(
              async (id) =>
                [id, (await reads.comment(user, target, id)) ? 'member' : 'missing'] as const,
            ),
          ),
        ),
    ),
  };
  return {
    service: new ConversationsService(prisma, redis, comments, reviews, client, resolver, reads),
    reads,
    resolver,
    prisma,
    entries,
    redis,
    comments,
  };
}

describe('merged conversation pagination', () => {
  it('merges stream heads across page boundaries without losing local rows', async () => {
    const remotes = Array.from({ length: 30 }, (_, i) => remote(i));
    const fixture = setup(
      [local(1, 1000), local(2, 0)],
      [
        { comments: remotes.slice(0, 20), nextCursor: '1' },
        { comments: remotes.slice(20), nextCursor: null },
      ],
    );
    const first = await fixture.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
    expect(first.items).toHaveLength(20);
    expect(first.items[0].key).toBe('local:local-1');
    expect(fixture.reads.comments).toHaveBeenCalledTimes(1);
    const second = await fixture.service.page(
      'user',
      'SHOW',
      'media',
      'MOST_LIKED',
      first.nextCursor!,
    );
    const all = [...first.items, ...second.items];
    expect(all).toHaveLength(32);
    expect(new Set(all.map((item) => item.key)).size).toBe(32);
    expect(second.items.at(-1)?.key).toBe('local:local-2');
    expect(second.nextCursor).toBeNull();
  });

  it('deduplicates an exact imported UUID, without deleting its local record', async () => {
    const original = { ...local(1), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) };
    const fixture = setup([original], [{ comments: [remote(1)], nextCursor: null }]);
    const result = await fixture.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
    expect(result.items).toHaveLength(1);
    expect(result.items[0].kind).toBe('commsuni');
    expect(fixture.prisma.comment).not.toHaveProperty('delete');
  });

  it('keeps only the mismatched imported copy local, per verdict', async () => {
    const fixture = setup(
      [
        { ...local(1), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) },
        { ...local(2), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(2) },
      ],
      [{ comments: [remote(1)], nextCursor: null }],
    );
    fixture.reads.archiveMembership.mockResolvedValueOnce(
      new Map([
        [uuid(1), 'member'],
        [uuid(2), 'mismatch'],
      ]),
    );
    const result = await fixture.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
    expect(result.upstream).toBe('available');
    expect(result.items.map((item) => item.key).sort()).toEqual(
      ['commsuni:' + uuid(1), 'local:local-2'].sort(),
    );
    expect(fixture.reads.commentsByIds).not.toHaveBeenCalled();
  });

  it('preserves uncertain imported identities instead of matching comment text', async () => {
    const original = {
      ...local(1),
      source: 'TVTIME',
      sourceKey: 'tvtime|cid:12',
      body: 'Remote 1',
    };
    const fixture = setup([original], [{ comments: [remote(1)], nextCursor: null }]);
    expect((await fixture.service.page('user', 'SHOW', 'media', 'MOST_LIKED')).items).toHaveLength(
      2,
    );
  });

  it('does not allow a cursor to move between users, sorts, or media', async () => {
    const fixture = setup(
      Array.from({ length: 25 }, (_, i) => local(i)),
      [{ comments: [], nextCursor: null }],
    );
    const first = await fixture.service.page('alice', 'SHOW', 'media', 'LATEST');
    await expect(
      fixture.service.page('bob', 'SHOW', 'media', 'LATEST', first.nextCursor!),
    ).rejects.toThrow('expired');
    await expect(
      fixture.service.page('alice', 'SHOW', 'other', 'LATEST', first.nextCursor!),
    ).rejects.toThrow('mapping changed');
    await expect(
      fixture.service.page('alice', 'SHOW', 'media', 'MOST_LIKED', first.nextCursor!),
    ).rejects.toThrow('expired');
  });

  it('blocks further provider reads after a mid-scroll mapping change', async () => {
    const fixture = setup(
      Array.from({ length: 25 }, (_, i) => local(i)),
      [{ comments: [], nextCursor: null }],
    );
    const first = await fixture.service.page('alice', 'SHOW', 'media', 'LATEST');
    fixture.resolver.resolve.mockResolvedValue({
      threadId: 'media',
      entityId: entity,
      fingerprint: 'changed',
    });
    await expect(
      fixture.service.page('alice', 'SHOW', 'media', 'LATEST', first.nextCursor!),
    ).rejects.toThrow('mapping changed');
    expect(fixture.reads.comments).toHaveBeenCalledTimes(1);
  });
});

describe('blocked author local-copy regression', () => {
  it.each(['import', 'publication'])(
    'hides a blocked author through a matching %s copy',
    async (kind) => {
      const copy =
        kind === 'import'
          ? { ...local(1, 1000), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) }
          : { ...local(1, 1000), commsUniCommentId: uuid(1), commsUniEntityId: entity };
      const f = setup([copy], [{ comments: [], nextCursor: null }]);
      f.prisma.commsUniAuthorBlock.findMany.mockResolvedValue([{ authorId: uuid(999) }]);
      f.reads.comment.mockRejectedValue(new Error('Blocked author'));
      const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
      expect(page.items).toEqual([]);
    },
  );
});

describe('source and moderation boundaries', () => {
  it('does not allow a cursor to switch source filters', async () => {
    const f = setup(
      Array.from({ length: 25 }, (_, i) => local(i)),
      [{ comments: [], nextCursor: null }],
    );
    const first = await f.service.page(
      'user',
      'SHOW',
      'media',
      'LATEST',
      undefined,
      undefined,
      '__local__',
    );
    await expect(
      f.service.page('user', 'SHOW', 'media', 'LATEST', first.nextCursor!),
    ).rejects.toThrow('expired');
  });
  it('hides locally moderated shared copies without depending on provider page order', async () => {
    const f = setup(
      [{ ...local(1), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) }],
      [{ comments: [], nextCursor: null }],
    );
    f.prisma.commsUniReport.findMany.mockResolvedValue([{ commentId: uuid(1) }]);
    expect((await f.service.page('user', 'SHOW', 'media', 'LATEST')).items).toEqual([]);
  });
  it('preserves an unrelated local comment during a provider outage and author block', async () => {
    const f = setup([local(1)], []);
    f.prisma.commsUniAuthorBlock.findMany.mockResolvedValue([{ authorId: uuid(999) }]);
    f.reads.comments.mockRejectedValue(new Error('Provider unavailable'));
    expect((await f.service.page('user', 'SHOW', 'media', 'LATEST')).items[0].key).toBe(
      'local:local-1',
    );
  });
  it('rechecks a native block added after the first cursor page', async () => {
    const f = setup(
      Array.from({ length: 25 }, (_, i) => local(i)),
      [{ comments: [], nextCursor: null }],
    );
    const first = await f.service.page('viewer', 'SHOW', 'media', 'LATEST');
    f.prisma.block.findMany.mockResolvedValue([{ blockedId: 'user' }]);
    expect(
      (await f.service.page('viewer', 'SHOW', 'media', 'LATEST', first.nextCursor!)).items,
    ).toEqual([]);
  });
});

it('rejects a cursor if the provider reference changes with the same local fingerprint', async () => {
  const f = setup(
    [],
    [{ comments: Array.from({ length: 20 }, (_, i) => remote(i)), nextCursor: 'next' }],
  );
  const first = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
  const target = await f.resolver.resolve();
  f.resolver.resolve.mockResolvedValue({ ...target, reference: 'tvdb-999' });
  await expect(
    f.service.page('user', 'SHOW', 'media', 'MOST_LIKED', first.nextCursor!),
  ).rejects.toThrow('Conversation mapping changed');
});

describe('backfilled comment engagement', () => {
  const linked = () => ({ ...local(1, 500), commsUniCommentId: uuid(1), commsUniEntityId: entity });
  it('uses provider rank and viewer engagement instead of historical local likes', async () => {
    const f = setup(
      [linked(), local(2, 2)],
      [{ comments: [{ ...remote(1, 1), viewerLiked: true }], nextCursor: null }],
    );
    const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
    expect(page.items.map((row) => row.kind)).toEqual(['local', 'commsuni']);
    expect(page.items[1]).toMatchObject({ comment: { likeCount: 1, viewerLiked: true } });
  });
  it('retains the local copy during a provider outage', async () => {
    const f = setup([linked()], []);
    f.reads.comments.mockRejectedValue(Error('offline'));
    const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
    expect(page.items).toHaveLength(1);
    expect(page.items[0].key).toBe('local:local-1');
  });
});

it('keeps pagination usable after a normal reading pause and bounds each local query', async () => {
  jest.useFakeTimers();
  try {
    const f = setup(
      Array.from({ length: 125 }, (_, i) => local(i, i)),
      [{ comments: [], nextCursor: null }],
    );
    const items: any[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED', cursor);
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
      jest.advanceTimersByTime(61000);
    } while (cursor);
    expect(items).toHaveLength(125);
    expect(new Set(items.map((item) => item.key)).size).toBe(125);
    expect(items.map((item) => item.comment.likesCount)).toEqual(
      Array.from({ length: 125 }, (_, i) => 124 - i),
    );
    const reads = f.prisma.comment.findMany.mock.calls.filter(([q]: any[]) => q.where.threadType);
    expect(reads.every(([q]: any[]) => q.take === 21)).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
it('uses provider counters and actions even when the imported copy has more local likes', async () => {
  const f = setup(
    [{ ...local(1, 500), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) }],
    [{ comments: [remote(1, 10)], nextCursor: null }],
  );
  const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
  expect(page.upstream).toBe('available');
  expect(page.items).toHaveLength(1);
  expect(page.items[0]).toMatchObject({ kind: 'commsuni', comment: { likeCount: 10 } });
});

it('removes a locally deleted provider row from a saved continuation buffer', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => remote(i));
  const f = setup([local(99, 1000)], [{ comments: rows, nextCursor: null }]);
  const first = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
  const original = f.prisma.comment.findMany.getMockImplementation();
  f.prisma.comment.findMany.mockImplementation(async (q: any) =>
    q.where.commsUniCommentId
      ? [{ commsUniCommentId: uuid(19), deletedByUser: true }]
      : original(q),
  );
  const second = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED', first.nextCursor!);
  expect(
    [...first.items, ...second.items].some(
      (row) => row.kind === 'commsuni' && row.comment.id === uuid(19),
    ),
  ).toBe(false);
});

it('does not leak imported fallback rows into a different source filter during an outage', async () => {
  const f = setup([{ ...local(1), source: 'TVTIME', sourceKey: 'tvtime|' + uuid(1) }], []);
  f.reads.sources = jest.fn(async () => new Map([['other', {}]]));
  f.reads.comment.mockResolvedValue({ ...remote(1), origin: { slug: 'tvtime' } });
  f.reads.comments.mockRejectedValue(new Error('temporary outage'));
  const page = await f.service.page(
    'user',
    'SHOW',
    'media',
    'LATEST',
    undefined,
    undefined,
    'other',
  );
  expect(page.items).toEqual([]);
});

it.each(['LATEST', 'MOST_LIKED'] as const)(
  'shows a local revision once instead of the immutable shared original (%s)',
  async (sort) => {
    const revised = {
      ...local(1, 1),
      body: 'Edited locally',
      hasLocalRevision: true,
      commsUniCommentId: uuid(1),
      commsUniEntityId: entity,
    };
    const f = setup([revised], [{ comments: [remote(1, 100)], nextCursor: null }]);
    const page = await f.service.page('user', 'SHOW', 'media', sort);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: 'local',
      key: 'local:local-1',
      comment: { id: 'local-1', body: 'Edited locally', hasLocalRevision: true },
    });
  },
);

it('keeps an edited imported copy separate instead of replacing the archive original', async () => {
  const revision = {
    ...local(1, 999),
    source: 'TVTIME',
    sourceKey: 'tvtime|' + uuid(1),
    hasLocalRevision: true,
    body: 'Local imported revision',
  };
  const f = setup([revision], [{ comments: [remote(1, 10)], nextCursor: null }]);
  const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
  expect(page.items).toHaveLength(2);
  expect(page.items.find((item) => item.kind === 'commsuni')).toMatchObject({
    comment: { id: uuid(1), text: 'Remote 1' },
  });
  expect(page.items.find((item) => item.kind === 'local')).toMatchObject({
    comment: { id: revision.id, body: 'Local imported revision' },
  });
});

it('bounds cursor storage to two snapshots and supports retrying the last page', async () => {
  const f = setup(
    Array.from({ length: 1000 }, (_, i) => local(i, i)),
    [{ comments: [], nextCursor: null }],
  );
  let cursor: string | undefined;
  const ids: string[] = [];
  let biggest = 0;
  do {
    const input = cursor;
    const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED', input);
    ids.push(...page.items.map((item) => item.key));
    if (input) {
      const retry = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED', input);
      expect(retry).toEqual(page);
    }
    expect(f.entries.size).toBeLessThanOrEqual(2);
    const sizes = [...f.entries.values()].map((value) => JSON.stringify(value).length);
    biggest = Math.max(biggest, ...sizes);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(biggest * 2);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(1000);
  expect(new Set(ids).size).toBe(1000);
});

it('loads local rows and revisions together once per feed page', async () => {
  const revised = {
    ...local(1, 1),
    hasLocalRevision: true,
    commsUniCommentId: uuid(1),
    commsUniEntityId: entity,
  };
  const f = setup([local(2, 200), revised], [{ comments: [remote(1)], nextCursor: null }]);
  const page = await f.service.page('user', 'SHOW', 'media', 'MOST_LIKED');
  expect(page.items).toHaveLength(2);
  expect(f.comments.conversationBatch).toHaveBeenCalledTimes(1);
  expect(f.comments.conversationBatch).toHaveBeenCalledWith('user', ['local-2'], {
    threadType: 'SHOW',
    threadId: 'media',
    ids: [uuid(1)],
  });
});
