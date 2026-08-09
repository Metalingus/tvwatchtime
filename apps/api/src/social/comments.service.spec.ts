import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CommentThreadType } from '@prisma/client';
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
    mediaItem: { findMany: jest.fn().mockResolvedValue([]) },
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
  const service = new CommentsService(prisma, events, notifications, commentImages);
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

  it('rejects a non-GIPHY gif URL', async () => {
    const { service } = makeService();
    await expect(
      service.create('u1', { ...base, body: '', gifUrl: 'https://example.com/x.gif' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

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
    const service = new CommentsService(prisma, events, notifications, commentImages);
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
    const service = new CommentsService(prisma, events, notifications, mockCommentImages() as any);

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

  it('rejects an invalid GIF on edit', async () => {
    const { service } = makeService(makeComment({ body: 'keep', userId: 'u1' }));
    await expect(
      service.update('u1', 'c1', { gifUrl: 'https://evil.com/x.gif' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('detaches the image when requested', async () => {
    const img = { id: 'img1', commentId: 'c1', userId: 'u1', status: 'ready' };
    const { service, commentImages, prisma } = makeService(
      makeComment({ body: 'keep', userId: 'u1', image: img }),
    );
    (prisma.commentImage.findUnique as jest.Mock).mockResolvedValue(img);
    await service.update('u1', 'c1', { detachImage: true });
    expect(commentImages.remove).toHaveBeenCalledWith('u1', 'img1');
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
    const service = new CommentsService(prisma, { emit: jest.fn() } as any, {} as any, {} as any);
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
      prisma,
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
    const service = new CommentsService(prisma, { emit: jest.fn() } as any, {} as any, {} as any);
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
