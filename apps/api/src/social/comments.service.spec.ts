// Catalog locking is exercised by the real-database fence suite; these tests isolate service behavior.
jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
function withMockTransaction<T>(prisma: T): T {
  const client = prisma as any;
  if (!client.$transaction)
    client.$transaction = jest.fn(async (work: any) =>
      typeof work === 'function' ? work(client) : Promise.all(work),
    );
  return prisma;
}
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommentThreadType } from '@prisma/client';
import { CommsUniReadService } from '../commsuni/commsuni.read.service';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import { CommentsService, MAX_COMMENT_DEPTH } from './comments.service';

function makeComment(over: Record<string, any> = {}) {
  return {
    id: 'c1',
    parentId: null,
    depth: 0,
    rootId: null,
    threadType: 'SHOW',
    threadId: 't1',
    userId: 'u1',
    body: '',
    imageUrl: null,
    gifUrl: null,
    likesCount: 0,
    repliesCount: 0,
    deletedByUser: false,
    editedAt: null,
    createdAt: new Date(),
    user: { id: 'u1', username: 'alice', profile: null, createdAt: new Date('2024-01-01') },
    image: null,
    ...over,
  };
}

function mockPrisma(commentRow: any = makeComment()) {
  return {
    block: { findMany: jest.fn().mockResolvedValue([]) },
    comment: {
      findUnique: jest.fn().mockResolvedValue(commentRow),
      findMany: jest.fn().mockResolvedValue([commentRow]),
      count: jest.fn().mockResolvedValue(1),
      groupBy: jest.fn().mockResolvedValue([]),
      create: jest.fn(async (args: any) => ({
        ...commentRow,
        ...args.data,
        gifUrl: args.data.gifUrl ?? null,
      })),
      update: jest.fn(async (args: any) => ({ ...commentRow, ...args.data })),
    },
    commentImage: { findUnique: jest.fn().mockResolvedValue(null) },
    commentLike: { findMany: jest.fn().mockResolvedValue([]) },
    commentSpoilerReport: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ type: commentRow?.threadType === 'MOVIE' ? 'MOVIE' : 'SHOW' }),
    },
    episode: { findMany: jest.fn().mockResolvedValue([]) },
    follow: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function mockCommentImages() {
  return { remove: jest.fn().mockResolvedValue({ ok: true }) };
}

function makeService(commentRow: any = makeComment()) {
  const prisma: any = mockPrisma(commentRow);
  const events: any = { emit: jest.fn() };
  const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const commentImages: any = mockCommentImages();
  const service = new CommentsService(
    withMockTransaction(prisma),
    events,
    notifications,
    commentImages,
  );
  return { service, prisma, events, notifications, commentImages };
}

const base = { threadType: CommentThreadType.SHOW, threadId: 't1' };

describe('CommentsService DTO attachments', () => {
  it('does not render a legacy mediaId-only row as a media card', () => {
    const row = makeComment({ mediaId: 'm1', mediaType: null });
    const { service } = makeService(row);

    const dto = (service as any).toDto(
      row,
      { followersCount: 0, followingCount: 0, commentsCount: 1 },
      false,
      { media: { mediaId: 'm1', title: 'Monster (2022)' } },
    );

    expect(dto.media).toBeNull();
  });
});

describe('CommentsService.create — GIF support', () => {
  it('creates a text-only comment', async () => {
    const { service, prisma } = makeService();
    const res = await service.create('u1', { ...base, body: 'hello' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: 'hello', gifUrl: undefined }),
      }),
    );
    expect(res.gifUrl).toBeNull();
  });

  it('creates a GIF-only comment with empty body', async () => {
    const { service, prisma } = makeService();
    const res = await service.create('u1', {
      ...base,
      body: '',
      gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
    } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: '',
          gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
        }),
      }),
    );
    expect(res.body).toBe('');
  });

  it('creates a text + GIF comment', async () => {
    const { service } = makeService();
    await service.create('u1', {
      ...base,
      body: 'nice',
      gifUrl: 'https://media1.giphy.com/media/abc/200.gif',
    } as any);
  });

  it('rejects empty body with no attachment', async () => {
    const { service } = makeService();
    await expect(service.create('u1', { ...base, body: '   ' } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('rejects an HTTP gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'http://media.giphy.com/g.gif' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['https://media.tenor.com/example/tenor.gif', 'https://another-provider.example/x.gif'])(
    'accepts a GIF from another provider: %s',
    async (gifUrl) => {
      const { service } = makeService();
      await expect(
        service.create('u1', { ...base, body: '', gifUrl } as any),
      ).resolves.toMatchObject({ gifUrl });
    },
  );

  it('rejects a malformed gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'not-a-url' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects both an image and a GIF', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', {
        ...base,
        body: 'x',
        imageUrl: 'https://x',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('preserves null gifUrl for legacy rows in list/replies', async () => {
    const { service } = makeService(makeComment({ gifUrl: null }));
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].gifUrl).toBeNull();
    const replies = await service.replies('u1', 'c1', {} as any);
    expect(replies.items[0].gifUrl).toBeNull();
  });

  it('returns gifUrl when present in list/replies', async () => {
    const { service } = makeService(
      makeComment({ gifUrl: 'https://media.giphy.com/media/abc/giphy.gif' }),
    );
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
    const replies = await service.replies('u1', 'c1', {} as any);
    expect(replies.items[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
  });

  it('list includes the thread display context for the feed header', async () => {
    const { service, prisma } = makeService(makeComment({ threadType: 'SHOW', threadId: 'm1' }));
    prisma.mediaItem.findMany = jest
      .fn()
      .mockResolvedValue([
        { id: 'm1', titles: { en: 'The Show' }, title: 'The Show', show: null, movie: null },
      ]);
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 'm1' } as any);
    expect(list.thread?.label).toBe('The Show');
    expect(list.thread?.mediaId).toBe('m1');
  });

  it('reply with missing parent throws NotFound', async () => {
    const prisma: any = mockPrisma(null);
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const commentImages: any = mockCommentImages();
    const service = new CommentsService(
      withMockTransaction(prisma),
      events,
      notifications,
      commentImages,
    );
    await expect(
      service.create('u1', { ...base, body: 'hi', parentId: 'missing' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects replying to a tombstone parent', async () => {
    const { service } = makeService(makeComment({ parentId: null, deletedByUser: true }));
    await expect(
      service.create('u1', { ...base, body: 'hi', parentId: 'c1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService.list — independently cloned split threads', () => {
  it('reads only the selected episode thread after a split clone', async () => {
    const row = makeComment({ threadType: 'EPISODE', threadId: 'part-2' });
    const { service, prisma } = makeService(row);

    await service.list('u1', {
      threadType: CommentThreadType.EPISODE,
      threadId: 'part-2',
    } as any);

    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          threadType: CommentThreadType.EPISODE,
          threadId: 'part-2',
        }),
      }),
    );
  });
});

describe('CommentsService.create — nested threads', () => {
  it('reply to a top-level comment gets depth 1 and rootId = parent id', async () => {
    const parent = makeComment({ id: 'p1', parentId: null, depth: 0, rootId: null });
    const { service, prisma } = makeService(parent);
    await service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'p1', depth: 1, rootId: 'p1' }),
      }),
    );
  });

  it('reply to a reply nests deeper and keeps the original root', async () => {
    const parent = makeComment({ id: 'p2', parentId: 'p1', depth: 1, rootId: 'p1' });
    const { service, prisma } = makeService(parent);
    await service.create('u2', { ...base, body: 'hi', parentId: 'p2' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ parentId: 'p2', depth: 2, rootId: 'p1' }),
      }),
    );
  });

  it('rejects a reply whose parent lives in another thread', async () => {
    const parent = makeComment({ id: 'p1', threadId: 'other-thread' });
    const { service } = makeService(parent);
    await expect(
      service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects replying past the max depth', async () => {
    const parent = makeComment({
      id: 'p1',
      parentId: 'root',
      depth: MAX_COMMENT_DEPTH,
      rootId: 'root',
    });
    const { service } = makeService(parent);
    await expect(
      service.create('u2', { ...base, body: 'hi', parentId: 'p1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('CommentsService.replies — depth=2', () => {
  it('depth=1 (default) does not fetch the second layer', async () => {
    const { service, prisma } = makeService();
    await service.replies('u1', 'c1', { page: 1, pageSize: 20 } as any);
    // One canonical-aware author-count query is expected; depth=1 must not add the
    // recursive preview query used by depth=2.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('depth=2 appends preview children after direct children; total counts direct only', async () => {
    const direct = makeComment({ id: 'd1', parentId: 'c1', depth: 1, rootId: 'c1' });
    const child = makeComment({
      id: 'd1a',
      parentId: 'd1',
      depth: 2,
      rootId: 'c1',
      userId: 'u2',
      user: { id: 'u2', username: 'bob', profile: null, createdAt: new Date('2024-01-01') },
    });
    const prisma: any = mockPrisma(direct);
    prisma.comment.findMany = jest
      .fn()
      .mockResolvedValueOnce([direct]) // direct-children page
      .mockResolvedValueOnce([child]); // preview hydration
    prisma.comment.count = jest.fn().mockResolvedValue(5);
    prisma.$queryRaw = jest.fn().mockResolvedValue([{ id: 'd1a' }]);
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const service = new CommentsService(
      withMockTransaction(prisma),
      events,
      notifications,
      mockCommentImages() as any,
    );

    const res = await service.replies('u1', 'c1', { page: 1, pageSize: 20, depth: 2 } as any);
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(res.items.map((i: any) => i.id)).toEqual(['d1', 'd1a']);
    expect(res.items[0].depth).toBe(1);
    expect(res.items[1].depth).toBe(2);
    expect(res.total).toBe(5);
  });
});

describe('CommentsService.replies — pagination', () => {
  it('returns a paginated payload with hasMore', async () => {
    const { service } = makeService();
    const res = await service.replies('u1', 'c1', { page: 1, pageSize: 20 } as any);
    expect(res).toHaveProperty('items');
    expect(res).toHaveProperty('total');
    expect(res).toHaveProperty('hasMore');
    expect(Array.isArray(res.items)).toBe(true);
  });
});

describe('CommentsService.findOne', () => {
  it('returns the comment dto', async () => {
    const { service } = makeService(makeComment({ body: 'hi' }));
    const res = await service.findOne('u2', 'c1');
    expect(res.id).toBe('c1');
    expect(res.body).toBe('hi');
    expect(res.deletedByUser).toBe(false);
    expect(res.isEdited).toBe(false);
  });

  it('throws NotFound for hidden comments', async () => {
    const { service } = makeService(makeComment({ hidden: true }));
    await expect(service.findOne('u2', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns thread context and an empty ancestor chain for a top-level comment', async () => {
    const { service, prisma } = makeService(makeComment({ threadType: 'SHOW', threadId: 'm1' }));
    prisma.mediaItem.findMany = jest
      .fn()
      .mockResolvedValue([
        { id: 'm1', titles: { en: 'The Show' }, title: 'The Show', show: null, movie: null },
      ]);
    const res = await service.findOne('u2', 'c1');
    expect(res.context?.label).toBe('The Show');
    expect(res.context?.mediaId).toBe('m1');
    expect(res.ancestors).toEqual([]);
  });

  it('returns the ancestor chain (root-first) for a deep reply', async () => {
    const root = makeComment({
      id: 'root',
      body: 'root',
      userId: 'u3',
      user: { id: 'u3', username: 'carol', profile: null, createdAt: new Date('2024-01-01') },
    });
    const mid = makeComment({
      id: 'mid',
      parentId: 'root',
      depth: 1,
      rootId: 'root',
      body: 'mid',
      userId: 'u2',
      user: { id: 'u2', username: 'bob', profile: null, createdAt: new Date('2024-01-01') },
    });
    const leaf = makeComment({
      id: 'leaf',
      parentId: 'mid',
      depth: 2,
      rootId: 'root',
      body: 'leaf',
    });
    const { service, prisma } = makeService(leaf);
    const byId: Record<string, any> = { root, mid, leaf };
    prisma.comment.findUnique = jest
      .fn()
      .mockImplementation(async (args: any) => byId[args.where.id] ?? null);
    const res = await service.findOne('u1', 'leaf');
    expect(res.id).toBe('leaf');
    expect(res.ancestors.map((a: any) => a.id)).toEqual(['root', 'mid']);
  });

  it('attaches the provider review as pseudo-parent for a review reply', async () => {
    const { service, prisma } = makeService(
      makeComment({ body: 'Nice', externalReviewId: 'er1', threadType: 'MOVIE', threadId: 'm1' }),
    );
    prisma.externalReview = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'er1',
        provider: 'TMDB',
        author: 'r96sk',
        username: 'r96sk',
        avatarUrl: null,
        rating: 9,
        content: 'a cracker!',
        url: 'https://tmdb/x',
        likesCount: 1,
        reviewCreatedAt: new Date('2024-09-11'),
      }),
    };
    prisma.externalReviewLike = { findUnique: jest.fn().mockResolvedValue(null) };
    prisma.comment.count = jest.fn().mockResolvedValue(1);
    const res = await service.findOne('u1', 'c1');
    expect(res.review?.kind).toBe('review');
    expect(res.review?.reviewId).toBe('er1');
    expect(res.review?.author.username).toBe('r96sk');
    expect(res.review?.repliesCount).toBe(1);
    expect(res.ancestors).toEqual([]);
  });
});

describe('CommentsService.update', () => {
  it('edits body and marks edited', async () => {
    const { service, prisma } = makeService(makeComment({ body: 'old', userId: 'u1' }));
    const res = await service.update('u1', 'c1', { body: 'new' });
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ body: 'new', editedAt: expect.any(Date) }),
      }),
    );
    expect(res.body).toBe('new');
    expect(res.isEdited).toBe(true);
  });

  it('forbids editing another user comment', async () => {
    const { service } = makeService(makeComment({ userId: 'u1' }));
    await expect(service.update('u2', 'c1', { body: 'x' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('rejects clearing everything (no text/attachment)', async () => {
    const { service } = makeService(
      makeComment({ body: 'old', userId: 'u1', gifUrl: null, image: null }),
    );
    await expect(service.update('u1', 'c1', { body: '   ' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('clears a GIF by passing null', async () => {
    const { service, prisma } = makeService(
      makeComment({
        body: 'keep',
        userId: 'u1',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
      }),
    );
    await service.update('u1', 'c1', { gifUrl: null });
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ gifUrl: null }) }),
    );
  });

  it('accepts replacing a GIF with a different provider on edit', async () => {
    const { service } = makeService(makeComment({ body: 'keep', userId: 'u1' }));
    await expect(
      service.update('u1', 'c1', { gifUrl: 'https://media.tenor.com/new/tenor.gif' }),
    ).resolves.toMatchObject({ gifUrl: 'https://media.tenor.com/new/tenor.gif' });
  });

  it('rejects an invalid GIF on edit', async () => {
    const { service } = makeService(makeComment({ body: 'keep', userId: 'u1' }));
    await expect(
      service.update('u1', 'c1', { gifUrl: 'javascript:alert(1)' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('detaches the image when requested', async () => {
    const img = { id: 'img1', commentId: 'c1', userId: 'u1', status: 'ready' };
    const { service, commentImages, prisma } = makeService(
      makeComment({ body: 'keep', userId: 'u1', image: img }),
    );
    (prisma.commentImage.findUnique as jest.Mock).mockResolvedValue(img);
    await service.update('u1', 'c1', { detachImage: true });
    expect(commentImages.remove).toHaveBeenCalledWith('u1', 'img1', true);
  });

  it('forbids editing a tombstone', async () => {
    const { service } = makeService(makeComment({ userId: 'u1', deletedByUser: true }));
    await expect(service.update('u1', 'c1', { body: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('CommentsService.softDelete', () => {
  it('sets deletedByUser tombstone', async () => {
    const { service, prisma } = makeService(makeComment({ userId: 'u1', body: 'gone' }));
    const res = await service.softDelete('u1', 'c1');
    expect(res.deleted).toBe(true);
    expect(prisma.comment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedByUser: true }) }),
    );
  });

  it('forbids deleting another user comment', async () => {
    const { service } = makeService(makeComment({ userId: 'u1' }));
    await expect(service.softDelete('u2', 'c1')).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('CommentsService tombstone mapping', () => {
  it('hides body/image/gif on a tombstone in list', async () => {
    const { service } = makeService(
      makeComment({
        deletedByUser: true,
        body: 'secret',
        gifUrl: 'https://media.giphy.com/media/abc/giphy.gif',
        image: { id: 'img1', status: 'ready', width: 10, height: 10, blurhash: 'abc' },
      }),
    );
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].deletedByUser).toBe(true);
    expect(list.items[0].body).toBe('');
    expect(list.items[0].gifUrl).toBeNull();
    expect(list.items[0].image).toBeNull();
  });
});

describe('CommentsService notification links', () => {
  it('reply notification links to the parent comment with highlight', async () => {
    const parent = makeComment({ id: 'p1', userId: 'u-owner', body: 'parent' });
    const { service, notifications } = makeService(parent);
    await service.create('u2', { ...base, parentId: 'p1', body: 'reply' } as any);
    expect(notifications.createForUser).toHaveBeenCalledWith(
      'u-owner',
      expect.objectContaining({
        category: 'COMMENT_REPLY',
        link: 'tvwatchtime://comment/p1?highlight=p1',
      }),
    );
  });

  it('like notification links to the liked comment with highlight', async () => {
    const { service, prisma, notifications } = makeService(
      makeComment({ id: 'c1', userId: 'u-owner' }),
    );
    prisma.commentLike.create = jest.fn().mockResolvedValue({});
    await service.like('u2', 'c1');
    expect(notifications.createForUser).toHaveBeenCalledWith(
      'u-owner',
      expect.objectContaining({
        category: 'COMMENT_LIKE',
        link: 'tvwatchtime://comment/c1?highlight=c1',
      }),
    );
  });
});

describe('CommentsService.listMine', () => {
  it('returns paginated comments with SHOW thread context', async () => {
    const { service, prisma } = makeService(
      makeComment({ id: 'c1', userId: 'u1', threadType: 'SHOW', threadId: 'm1', body: 'hi' }),
    );
    prisma.mediaItem = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'm1',
          type: 'SHOW',
          title: 'My Show',
          titles: null,
          show: { yearStart: 2021 },
          movie: null,
        },
      ]),
    };
    prisma.episode = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'c1' }]).mockResolvedValueOnce([{ count: 1 }]);
    const res = await service.listMine('u1', 1, 20);
    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['c1'] } } }),
    );
    expect(res.total).toBe(1);
    expect(res.items[0].context).toEqual(
      expect.objectContaining({ threadType: 'SHOW', mediaId: 'm1', label: 'My Show' }),
    );
  });

  it('resolves EPISODE context as "Show · S01E05" with the episode title', async () => {
    const { service, prisma } = makeService(makeComment({ threadType: 'EPISODE', threadId: 'e1' }));
    prisma.mediaItem = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.episode = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'e1',
          number: 5,
          title: 'The Episode',
          titles: null,
          season: {
            number: 1,
            show: { media: { id: 'm1', type: 'SHOW', title: 'My Show', titles: null } },
          },
        },
      ]),
    };
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'c1' }]).mockResolvedValueOnce([{ count: 1 }]);
    const res = await service.listMine('u1', 1, 20);
    expect(res.items[0].context).toEqual(
      expect.objectContaining({
        label: 'My Show · S01E05',
        sublabel: 'The Episode',
        mediaId: 'm1',
        episodeId: 'e1',
      }),
    );
  });

  it('resolves GROUP context to the group slug', async () => {
    const { service, prisma } = makeService(
      makeComment({ threadType: 'GROUP', threadId: 'anime' }),
    );
    prisma.mediaItem = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.episode = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'c1' }]).mockResolvedValueOnce([{ count: 1 }]);
    const res = await service.listMine('u1', 1, 20);
    expect(res.items[0].context).toEqual(
      expect.objectContaining({ label: 'anime', groupId: 'anime' }),
    );
  });

  it('excludes soft-deleted comments and paginates via skip/take', async () => {
    const { service, prisma } = makeService();
    prisma.mediaItem = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.episode = { findMany: jest.fn().mockResolvedValue([]) };
    prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ count: 0 }]);
    await service.listMine('u1', 2, 10);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });
});

describe('CommentsService.reportSpoiler', () => {
  function makeSpoilerService(comment: any) {
    const prisma: any = {
      comment: {
        findUnique: jest.fn().mockResolvedValue(comment),
        update: jest.fn(async (args: any) => ({
          ...comment,
          spoilerCount: comment.spoilerCount + 1,
          isSpoiler: !!args.data.isSpoiler || comment.isSpoiler,
        })),
      },
      commentSpoilerReport: {
        createMany: jest.fn(async () => ({ count: 1 })),
      },
    };
    const service = new CommentsService(
      withMockTransaction(prisma),
      { emit: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('increments the tally and flips isSpoiler at the threshold (5)', async () => {
    const comment: any = makeComment({ id: 'c1', userId: 'other' });
    comment.spoilerCount = 4;
    comment.isSpoiler = false;
    const { service, prisma } = makeSpoilerService(comment);

    const res = await service.reportSpoiler('u1', 'c1');

    expect(prisma.commentSpoilerReport.createMany).toHaveBeenCalledWith({
      data: [{ commentId: 'c1', userId: 'u1' }],
      skipDuplicates: true,
    });
    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { spoilerCount: { increment: 1 }, isSpoiler: true },
    });
    expect(res).toEqual({ reported: true, spoilerCount: 5, isSpoiler: true });
  });

  it('does NOT flip isSpoiler below the threshold', async () => {
    const comment: any = makeComment({ id: 'c1', userId: 'other' });
    comment.spoilerCount = 2;
    comment.isSpoiler = false;
    const { service, prisma } = makeSpoilerService(comment);

    const res = await service.reportSpoiler('u1', 'c1');

    expect(prisma.comment.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { spoilerCount: { increment: 1 } },
    });
    expect(res.isSpoiler).toBe(false);
  });

  it('is idempotent per user (second report is a no-op)', async () => {
    const comment: any = makeComment({ id: 'c1', userId: 'other' });
    comment.spoilerCount = 4;
    comment.isSpoiler = false;
    const { service, prisma } = makeSpoilerService(comment);
    prisma.commentSpoilerReport.createMany.mockResolvedValue({ count: 0 });

    const res = await service.reportSpoiler('u1', 'c1');

    expect(prisma.comment.update).not.toHaveBeenCalled();
    expect(res).toEqual({ reported: true, spoilerCount: 4, isSpoiler: false });
  });

  it('rejects self-reports (authors mark spoilers at creation)', async () => {
    const comment: any = makeComment({ id: 'c1', userId: 'u1' });
    comment.spoilerCount = 0;
    const { service } = makeSpoilerService(comment);

    await expect(service.reportSpoiler('u1', 'c1')).rejects.toThrow(BadRequestException);
  });
});

describe('CommentsService.list — TMDB external reviews', () => {
  it('merges stored TMDB reviews into the feed as pseudo-items (kind=review)', async () => {
    const prisma: any = mockPrisma();
    prisma.externalReview = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'er1',
          provider: 'TMDB',
          author: 'MovieGuys',
          username: 'mg',
          avatarUrl: null,
          rating: 8,
          content: 'provider review body',
          url: 'https://www.themoviedb.org/review/er1',
          likesCount: 3,
          reviewCreatedAt: new Date('2026-01-01'),
        },
      ]),
    };
    prisma.externalReviewLike = { findMany: jest.fn().mockResolvedValue([]) };
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const commentImages: any = mockCommentImages();
    const externalReviews: any = {
      ensureFreshForThread: jest.fn().mockResolvedValue(undefined),
    };
    const service = new CommentsService(
      withMockTransaction(prisma),
      events,
      notifications,
      commentImages,
      externalReviews,
    );

    const res = await service.list('u1', { threadType: 'SHOW', threadId: 'm1' } as any);

    expect(externalReviews.ensureFreshForThread).toHaveBeenCalledWith('SHOW', 'm1');
    const reviewItem: any = res.items.find((i: any) => i.kind === 'review');
    expect(reviewItem).toBeDefined();
    expect(reviewItem).toEqual(
      expect.objectContaining({
        provider: 'TMDB',
        reviewId: 'er1',
        body: 'provider review body',
        likesCount: 3,
        reviewUrl: 'https://www.themoviedb.org/review/er1',
      }),
    );
    expect(reviewItem.author.username).toBe('MovieGuys');
  });

  it('adds no review pseudo-items without the service (graceful degradation)', async () => {
    const { service } = makeService();

    const res = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);

    expect(res.items.every((i: any) => i.kind !== 'review')).toBe(true);
  });

  it('excludes review replies from the top-level feed (list + count)', async () => {
    const { service, prisma } = makeService();

    await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);

    expect(prisma.comment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ externalReviewId: null, parentId: null }),
      }),
    );
    expect(prisma.comment.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ externalReviewId: null }),
    });
  });
});

describe('CommentsService — external review threads (header + likes)', () => {
  function makeReviewService(review: any) {
    const prisma: any = {
      externalReview: {
        findUnique: jest.fn().mockResolvedValue(review),
        update: jest.fn(async () => ({})),
      },
      externalReviewLike: {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany: jest.fn(async () => ({})),
        deleteMany: jest.fn(async () => ({})),
        count: jest.fn(async () => 7),
      },
      comment: { count: jest.fn().mockResolvedValue(4) },
      mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
      episode: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new CommentsService(
      withMockTransaction(prisma),
      { emit: jest.fn() } as any,
      {} as any,
      {} as any,
    );
    return { service, prisma };
  }

  it('getExternalReview returns the thread header with counts + thread target', async () => {
    const { service } = makeReviewService({
      id: 'er1',
      provider: 'TMDB',
      author: 'A',
      username: 'a',
      avatarUrl: null,
      rating: 9,
      content: 'body',
      url: 'https://www.themoviedb.org/review/er1',
      likesCount: 3,
      reviewCreatedAt: new Date('2026-01-01'),
      mediaId: 'm1',
      episodeId: null,
      media: { type: 'SHOW' },
    });

    const res = await service.getExternalReview('u1', 'er1');

    expect(res).toEqual(
      expect.objectContaining({
        id: 'er1',
        likesCount: 3,
        repliesCount: 4,
        likedByMe: false,
        threadType: 'SHOW',
        threadId: 'm1',
      }),
    );
  });

  it('like/unlike syncs the denormalized likesCount from the like table', async () => {
    const { service, prisma } = makeReviewService({ id: 'er1' });

    const liked = await service.likeExternalReview('u1', 'er1');
    expect(prisma.externalReviewLike.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'u1', externalReviewId: 'er1' }],
      skipDuplicates: true,
    });
    expect(prisma.externalReview.update).toHaveBeenCalledWith({
      where: { id: 'er1' },
      data: { likesCount: 7 },
    });
    expect(liked).toEqual({ liked: true, likesCount: 7 });

    const unliked = await service.unlikeExternalReview('u1', 'er1');
    expect(unliked).toEqual({ liked: false, likesCount: 7 });
  });
});

describe('provider blocks also cover legacy local-copy routes', () => {
  it.each(['findOne', 'conversationRows'])(
    'enforces a provider block through %s',
    async (method) => {
      const row = makeComment({
        source: 'TVTIME',
        sourceKey: 'tvtime|11111111-1111-4111-8111-111111111111',
      });
      const f = makeService(row);
      (f.service as any).publication = { client: { enabled: true, scope: 'scope' } };
      (f.service as any).conversationResolver = {
        resolve: jest.fn().mockResolvedValue({ entityId: 'entity' }),
      };
      (f.service as any).sharedReads = {
        blockedIdentities: jest
          .fn()
          .mockResolvedValue({ authorIds: new Set(['blocked']), userIds: new Set() }),
        comment: jest.fn().mockRejectedValue(new NotFoundException()),
      };
      f.prisma.commsUniAuthorBlock = {
        findMany: jest.fn().mockResolvedValue([{ authorId: 'blocked' }]),
      };
      f.prisma.commsUniReport = {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      };
      if (method === 'findOne')
        await expect(f.service.findOne('viewer', row.id)).rejects.toBeInstanceOf(NotFoundException);
      else expect(await f.service.conversationRows('viewer', [row.id])).toEqual([]);
    },
  );
});

describe('text moderation for live comments', () => {
  function moderated() {
    const f = makeService(makeComment({ body: 'Original text' }));
    const moderation = {
      enabled: true,
      moderateText: jest.fn().mockResolvedValue({
        model: 'omni-moderation-latest',
        decision: 'allow',
        flagged: false,
      }),
    };
    (f.service as any).contentModeration = moderation;
    return { ...f, moderation };
  }
  it.each([undefined, 'parent'])(
    'checks the complete new comment/reply before saving',
    async (parentId) => {
      const f = moderated();
      await f.service.create('u1', { ...base, parentId, body: 'new text' });
      expect(f.moderation.moderateText).toHaveBeenCalledWith('new text');
      expect(f.moderation.moderateText.mock.invocationCallOrder[0]).toBeLessThan(
        f.prisma.comment.create.mock.invocationCallOrder[0],
      );
    },
  );
  it('rejects flagged text without saving a comment or emitting events', async () => {
    const f = moderated();
    f.moderation.moderateText.mockResolvedValue({ decision: 'reject' } as any);
    await expect(f.service.create('u1', { ...base, body: 'new text' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COMMENT_MODERATION_REJECTED' }),
    });
    expect(f.prisma.comment.create).not.toHaveBeenCalled();
    expect(f.events.emit).not.toHaveBeenCalled();
  });
  it('keeps a draft unsaved when configured moderation is unavailable', async () => {
    const f = moderated();
    f.moderation.moderateText.mockRejectedValue(new Error('offline'));
    await expect(f.service.create('u1', { ...base, body: 'new text' })).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'COMMENT_MODERATION_UNAVAILABLE' }),
    });
    expect(f.prisma.comment.create).not.toHaveBeenCalled();
  });
  it('preserves existing text and attachments when an edit is rejected', async () => {
    const f = moderated();
    f.moderation.moderateText.mockResolvedValue({ decision: 'reject' } as any);
    await expect(
      f.service.update('u1', 'c1', { body: 'replacement', detachImage: true }),
    ).rejects.toThrow();
    expect(f.prisma.comment.update).not.toHaveBeenCalled();
    expect(f.commentImages.remove).not.toHaveBeenCalled();
  });
  it('moderates edited text but does not repeat a check on unchanged text', async () => {
    const f = moderated();
    await f.service.update('u1', 'c1', { body: 'replacement' });
    expect(f.moderation.moderateText).toHaveBeenCalledWith('replacement');
    f.moderation.moderateText.mockClear();
    await f.service.update('u1', 'c1', { body: 'Original text' });
    expect(f.moderation.moderateText).not.toHaveBeenCalled();
  });
  it('keeps the established optional-key behavior for local comments', async () => {
    const f = moderated();
    f.moderation.enabled = false;
    await f.service.create('u1', { ...base, body: 'new text' });
    expect(f.moderation.moderateText).not.toHaveBeenCalled();
    expect(f.prisma.comment.create).toHaveBeenCalled();
  });
});

describe('confirmed shared detail engagement', () => {
  function fixture() {
    const row = makeComment({
      commsUniCommentId: 'remote',
      commsUniEntityId: 'entity',
      likesCount: 50,
    });
    const f = makeService(row);
    (f.service as any).publication = { client: { enabled: true } };
    (f.service as any).conversationResolver = {
      resolve: jest.fn().mockResolvedValue({ entityId: 'entity' }),
    };
    const reads = {
      comment: jest
        .fn()
        .mockResolvedValue({ likeCount: 1, viewerLiked: true, spoilerCount: 2, isSpoiler: true }),
    };
    (f.service as any).sharedReads = reads;
    jest.spyOn(f.service as any, 'assertSharedCopyVisible').mockResolvedValue(undefined);
    return { ...f, row, reads };
  }
  it('projects provider likes without altering historical local counters', async () => {
    const f = fixture();
    expect(await f.service.findOne('viewer', 'c1')).toMatchObject({
      likesCount: 1,
      likedByMe: true,
      spoilerCount: 2,
      isSpoiler: true,
    });
    expect(f.row.likesCount).toBe(50);
    expect(f.prisma.comment.update).not.toHaveBeenCalled();
  });
  it('keeps a local fallback during outages but hides a provider-deleted comment', async () => {
    const f = fixture();
    f.reads.comment.mockRejectedValueOnce(Error('offline'));
    expect(await f.service.findOne('viewer', 'c1')).toMatchObject({ likesCount: 50 });
    f.reads.comment.mockRejectedValueOnce(new NotFoundException());
    await expect(f.service.findOne('viewer', 'c1')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('local replies to provider messages with publishing disabled', () => {
  const parentId = '11111111-1111-4111-8111-111111111111';
  const entityId = '22222222-2222-4222-8222-222222222222';
  const authorId = '33333333-3333-4333-8333-333333333333';
  function setup() {
    const f = makeService();
    const raw: any = {
      id: parentId,
      entityId,
      userId: authorId,
      userName: 'Parent author',
      text: 'Parent',
      createdAt: '2026-01-01T00:00:00Z',
      depth: 2,
      origin: { kind: 'tvtime', slug: 'tvtime' },
    };
    const client: any = {
      scope: 'test',
      enabled: true,
      writesEnabled: false,
      read: jest.fn(async () => ({ comment: raw })),
      request: jest.fn(),
      assertWrites: jest.fn(() => {
        throw Error('Provider writes disabled');
      }),
    };
    const resolver: any = {
      canonicalThread: jest.fn(async (_type, id) => id),
      resolve: jest.fn().mockResolvedValue({
        threadType: 'SHOW',
        threadId: 't1',
        entityId,
        reference: 'tvdb-1',
        fingerprint: 'verified',
      }),
    };
    Object.assign(f.prisma, {
      user: { findUnique: jest.fn().mockResolvedValue({ isSuspended: false, isShadow: false }) },
      commsUniIdentity: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      commsUniAuthorBlock: { findMany: jest.fn().mockResolvedValue([]) },
      commsUniReport: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      commsUniOutbox: { create: jest.fn() },
      $transaction: jest.fn(async (fn) => fn(f.prisma)),
    });
    f.prisma.comment.findFirst = jest.fn().mockResolvedValue(null);
    const reads = new CommsUniReadService(client, resolver, f.prisma);
    jest.spyOn(reads, 'sources').mockResolvedValue(new Map());
    const publication = new CommsUniPublicationService(
      f.prisma,
      {} as any,
      {} as any,
      client,
      resolver,
      reads,
    );
    Object.assign(f.service, { publication, conversationResolver: resolver, sharedReads: reads });
    return { ...f, client, raw, resolver };
  }
  it('saves a reply to the selected depth-two message without enqueuing or calling a provider write', async () => {
    const f = setup();
    await f.service.create('u1', {
      ...base,
      body: 'Reply to this message',
      commsUniParentId: parentId,
    } as any);
    expect(f.prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'MANUAL',
          threadId: 't1',
          commsUniParentId: parentId,
        }),
      }),
    );
    expect(f.client.read).toHaveBeenCalledWith(
      'u1',
      '/comments/' + parentId,
      {},
      30,
      expect.stringContaining('entity:show:'),
    );
    expect(f.client.assertWrites).not.toHaveBeenCalled();
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.prisma.commsUniOutbox.create).not.toHaveBeenCalled();
  });
  it.each(['wrong-media', 'wrong-comment', 'deleted', 'blocked', 'suspended'])(
    'rejects a %s parent/account before saving',
    async (mode) => {
      const f = setup();
      if (mode === 'wrong-media') f.raw.entityId = '44444444-4444-4444-8444-444444444444';
      if (mode === 'wrong-comment') f.raw.id = '44444444-4444-4444-8444-444444444444';
      if (mode === 'deleted') f.raw.deleted = true;
      if (mode === 'blocked')
        f.prisma.commsUniAuthorBlock.findMany.mockResolvedValue([{ authorId }]);
      if (mode === 'suspended')
        f.prisma.user.findUnique.mockResolvedValue({ isSuspended: true, isShadow: false });
      await expect(
        f.service.create('u1', { ...base, body: 'Reply', commsUniParentId: parentId } as any),
      ).rejects.toThrow();
      expect(f.prisma.comment.create).not.toHaveBeenCalled();
      expect(f.client.request).not.toHaveBeenCalled();
    },
  );
  it('rejects a mismatched structured mention rather than targeting another author', async () => {
    const f = setup();
    await expect(
      f.service.create('u1', {
        ...base,
        body: '@Other Hi',
        commsUniParentId: parentId,
        commsUniMentions: [{ authorId: entityId, start: 0, end: 6, text: '@Other' }],
      } as any),
    ).rejects.toThrow('Invalid structured mention');
    expect(f.prisma.comment.create).not.toHaveBeenCalled();
  });
  it('rejects a reply timestamp older than its verified parent', async () => {
    const f = setup();
    await expect(
      f.service.create('u1', {
        ...base,
        body: 'Reply',
        commsUniParentId: parentId,
        createdAt: '2020-01-01T00:00:00Z',
      } as any),
    ).rejects.toThrow('Invalid comment timestamp');
    expect(f.prisma.comment.create).not.toHaveBeenCalled();
  });
});

it('replays an identical local-parent request after capture adds the provider parent', async () => {
  const service: any = Object.create(CommentsService.prototype);
  const dto: any = {
    threadType: 'SHOW',
    threadId: 'media',
    parentId: 'local-parent',
    clientActionId: 'action',
    body: 'same text',
  };
  const saved = { ...dto, id: 'saved', userId: 'user', commsUniParentId: 'provider-parent' };
  service.prisma = { comment: { findUnique: jest.fn(async () => saved) } };
  service.conversationResolver = { canonicalThread: async (_type: string, id: string) => id };
  service.findOne = jest.fn(async () => saved);
  await expect(service.create('user', dto)).resolves.toEqual(saved);
  await expect(service.create('user', { ...dto, body: 'different text' })).rejects.toThrow(
    'Action ID was reused',
  );
});

it('loads local comments and verified revisions in one metadata batch without replacing imports', async () => {
  const { service, prisma } = makeService();
  const shared = '11111111-1111-4111-8111-111111111111';
  const archive = '22222222-2222-4222-8222-222222222222';
  prisma.comment.findMany.mockResolvedValue([
    makeComment({ id: 'local', source: 'MANUAL', ...base }),
    makeComment({
      id: 'revised',
      source: 'MANUAL',
      hasLocalRevision: true,
      commsUniCommentId: shared,
      ...base,
    }),
    makeComment({
      id: 'imported',
      source: 'TVTIME',
      hasLocalRevision: true,
      commsUniCommentId: archive,
      ...base,
    }),
  ]);
  const batch = await service.conversationBatch('u1', ['local', 'imported'], {
    threadType: 'SHOW',
    threadId: 't1',
    ids: [shared, archive],
  });
  expect(batch.comments.map((comment) => comment.id)).toEqual(['local', 'revised', 'imported']);
  expect(batch.revisions.map((revision) => revision.comment.id)).toEqual(['revised']);
  expect(prisma.comment.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.commentLike.findMany).toHaveBeenCalledTimes(1);
  expect(prisma.commentSpoilerReport.findMany).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'wakes a newly saved comment only after a successful commit (rollback=%s)',
  async (rollback) => {
    const f = makeService();
    let committed = false;
    const publication = {
      capture: jest.fn(async (_tx, _user, row) => {
        expect(committed).toBe(false);
        row.commsUniState = 'PENDING';
      }),
      wake: jest.fn(async () => {
        expect(committed).toBe(true);
      }),
    };
    (f.service as any).publication = publication;
    f.prisma.$transaction = jest.fn(async (action) => {
      const value = await action(f.prisma);
      if (rollback) throw Error('rollback');
      committed = true;
      return value;
    });
    const request = f.service.create('u1', { ...base, body: 'New saved comment' } as any);
    if (rollback) await expect(request).rejects.toThrow('rollback');
    else await request;
    expect(publication.wake).toHaveBeenCalledTimes(rollback ? 0 : 1);
  },
);
