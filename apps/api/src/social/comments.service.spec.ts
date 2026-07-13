import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommentThreadType } from '@prisma/client';
import { CommentsService } from './comments.service';

function makeComment(over: Record<string, any> = {}) {
  return {
    id: 'c1',
    parentId: null,
    threadType: 'SHOW',
    threadId: 't1',
    userId: 'u1',
    body: '',
    imageUrl: null,
    gifUrl: null,
    likesCount: 0,
    repliesCount: 0,
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
      create: jest.fn(async (args: any) => ({ ...commentRow, ...args.data, gifUrl: args.data.gifUrl ?? null })),
      update: jest.fn().mockResolvedValue({}),
    },
    commentLike: { findMany: jest.fn().mockResolvedValue([]) },
    follow: { count: jest.fn().mockResolvedValue(0) },
  };
}

function makeService(commentRow: any = makeComment()) {
  const prisma: any = mockPrisma(commentRow);
  const events: any = { emit: jest.fn() };
  const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const service = new CommentsService(prisma, events, notifications);
  return { service, prisma, events, notifications };
}

const base = { threadType: CommentThreadType.SHOW, threadId: 't1' };

describe('CommentsService.create — GIF support', () => {
  it('creates a text-only comment', async () => {
    const { service, prisma } = makeService();
    const res = await service.create('u1', { ...base, body: 'hello' } as any);
    expect(prisma.comment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ body: 'hello', gifUrl: undefined }) }),
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
    const replies = await service.replies('u1', 'c1');
    expect(replies[0].gifUrl).toBeNull();
  });

  it('returns gifUrl when present in list/replies', async () => {
    const { service } = makeService(makeComment({ gifUrl: 'https://media.giphy.com/media/abc/giphy.gif' }));
    const list = await service.list('u1', { threadType: 'SHOW', threadId: 't1' } as any);
    expect(list.items[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
    const replies = await service.replies('u1', 'c1');
    expect(replies[0].gifUrl).toBe('https://media.giphy.com/media/abc/giphy.gif');
  });

  it('reply with missing parent throws NotFound', async () => {
    const prisma: any = mockPrisma(null);
    const events: any = { emit: jest.fn() };
    const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
    const service = new CommentsService(prisma, events, notifications);
    await expect(
      service.create('u1', { ...base, body: 'hi', parentId: 'missing' } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
