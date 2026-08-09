import { ListSource } from '@prisma/client';
import { SocialService } from './social.service';

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (min: number) => new Date(T0 + min * 60000);

function media(id: string, type: 'SHOW' | 'MOVIE' = 'MOVIE') {
  return {
    id,
    type,
    title: `Title ${id}`,
    posterUrl: `https://img/${id}.jpg`,
    show: type === 'SHOW' ? { yearStart: 2020 } : null,
    movie: type === 'MOVIE' ? { releaseYear: 2021 } : null,
  };
}

function userRow(id: string) {
  return {
    id,
    username: `user_${id}`,
    profile: { displayName: `Name ${id}`, avatarUrl: `https://img/${id}.png` },
  };
}

/** Apply the (mocked) time-filter/orderBy/take the service issues per source. */
function applySourceQuery(rows: any[], timeField: string, args: any) {
  const lte = args?.where?.[timeField]?.lte as Date | undefined;
  return rows
    .filter((r) => !lte || r[timeField] <= lte)
    .sort((a, b) => b[timeField].getTime() - a[timeField].getTime())
    .slice(0, args?.take ?? rows.length);
}

function mockPrisma() {
  const prisma: any = {
    follow: { findMany: jest.fn().mockResolvedValue([]) },
    block: { findMany: jest.fn().mockResolvedValue([]) },
    watchHistory: { findMany: jest.fn() },
    watchlistItem: { findMany: jest.fn() },
    favorite: { findMany: jest.fn() },
    rating: { findMany: jest.fn() },
    reaction: { findMany: jest.fn() },
    comment: { findMany: jest.fn() },
    mediaCanonicalLink: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: { findMany: jest.fn() },
    episode: { findMany: jest.fn() },
    user: { findMany: jest.fn() },
    $queryRaw: jest.fn(async () =>
      ((prisma as any)._comments ?? []).map((comment: any) => ({ id: comment.id })),
    ),
  };
  prisma.watchHistory.findMany.mockImplementation(async (args: any) =>
    applySourceQuery((prisma as any)._history ?? [], 'watchedAt', args),
  );
  prisma.watchlistItem.findMany.mockImplementation(async (args: any) =>
    applySourceQuery((prisma as any)._watchlist ?? [], 'createdAt', args),
  );
  prisma.favorite.findMany.mockImplementation(async (args: any) =>
    applySourceQuery((prisma as any)._favorites ?? [], 'createdAt', args),
  );
  prisma.rating.findMany.mockImplementation(async (args: any) =>
    applySourceQuery((prisma as any)._ratings ?? [], 'createdAt', args),
  );
  prisma.reaction.findMany.mockImplementation(async (args: any) =>
    applySourceQuery((prisma as any)._reactions ?? [], 'createdAt', args),
  );
  prisma.comment.findMany.mockImplementation(async (args: any) => {
    const rows = (prisma as any)._comments ?? [];
    if (args?.where?.id?.in) return rows.filter((row: any) => args.where.id.in.includes(row.id));
    return applySourceQuery(rows, 'createdAt', args);
  });
  prisma.mediaItem.findMany.mockImplementation(async (args: any) =>
    ((prisma as any)._media ?? []).filter((m: any) => args.where.id.in.includes(m.id)),
  );
  prisma.episode.findMany.mockImplementation(async (args: any) =>
    ((prisma as any)._episodes ?? []).filter((e: any) => args.where.id.in.includes(e.id)),
  );
  prisma.user.findMany.mockImplementation(async (args: any) =>
    ((prisma as any)._users ?? []).filter((u: any) => args.where.id.in.includes(u.id)),
  );
  return prisma;
}

function makeService() {
  const prisma = mockPrisma();
  const events: any = { emit: jest.fn() };
  const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const service = new SocialService(prisma, events, notifications);
  return { service, prisma };
}

describe('SocialService.getFeed', () => {
  it('audience is the viewer + followings, minus users the viewer blocked', async () => {
    const { service, prisma } = makeService();
    prisma.follow.findMany.mockResolvedValue([{ targetId: 'u2' }, { targetId: 'u3' }]);
    prisma.block.findMany.mockResolvedValue([{ blockedId: 'u3' }]);
    prisma._users = [userRow('u1'), userRow('u2')];

    await service.getFeed('u1');

    const where = prisma.watchHistory.findMany.mock.calls[0][0].where;
    expect(where.userId.in).toEqual(['u1', 'u2']);
    for (const model of ['watchlistItem', 'favorite', 'rating', 'reaction']) {
      expect(prisma[model].findMany.mock.calls[0][0].where.userId.in).toEqual(['u1', 'u2']);
    }
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('excludes import-sourced rows from ratings, reactions and comments', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];

    await service.getFeed('u1');

    const manualOnly = { OR: [{ source: ListSource.MANUAL }, { source: null }] };
    expect(prisma.rating.findMany.mock.calls[0][0].where).toMatchObject(manualOnly);
    expect(prisma.reaction.findMany.mock.calls[0][0].where).toMatchObject(manualOnly);
    // Comments use a raw id selector so polymorphic SHOW/EPISODE source threads can be hidden.
    expect(prisma.$queryRaw).toHaveBeenCalled();
  });

  it('masks spoiler comment excerpts and flags spoiler: true', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    prisma._media = [media('m1')];
    prisma._comments = [
      {
        id: 'c1',
        userId: 'u1',
        threadType: 'MOVIE',
        threadId: 'm1',
        body: 'the butler did it',
        isSpoiler: true,
        createdAt: at(2),
      },
      {
        id: 'c2',
        userId: 'u1',
        threadType: 'MOVIE',
        threadId: 'm1',
        body: 'great movie',
        isSpoiler: false,
        createdAt: at(1),
      },
    ];

    const res = await service.getFeed('u1');

    expect(res.items).toHaveLength(2);
    const spoiler = res.items.find((i) => i.id === 'com:c1')!;
    expect(spoiler.type).toBe('COMMENTED');
    expect(spoiler.spoiler).toBe(true);
    expect(spoiler.detail?.excerpt).toBeUndefined();
    expect(spoiler.detail?.commentId).toBe('c1');
    const open = res.items.find((i) => i.id === 'com:c2')!;
    expect(open.spoiler).toBeUndefined();
    expect(open.detail?.excerpt).toBe('great movie');
    expect(open.detail?.commentId).toBe('c2');
  });

  it('merges sources newest-first and cursor-paginates by (timestamp, id)', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    prisma._history = [
      { id: 'h1', userId: 'u1', mediaType: 'MOVIE', watchedAt: at(5), media: media('m1') },
      { id: 'h2', userId: 'u1', mediaType: 'MOVIE', watchedAt: at(3), media: media('m2') },
    ];
    prisma._favorites = [
      { id: 'f1', userId: 'u1', createdAt: at(4), media: media('m3') },
      { id: 'f2', userId: 'u1', createdAt: at(2), media: media('m4') },
    ];

    const page1 = await service.getFeed('u1', undefined, 2);
    expect(page1.items.map((i) => i.id)).toEqual(['wh:h1', 'fav:f1']);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await service.getFeed('u1', page1.nextCursor, 2);
    expect(page2.items.map((i) => i.id)).toEqual(['wh:h2', 'fav:f2']);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('orders same-timestamp rows by id descending so pagination stays stable', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    prisma._favorites = [
      { id: 'a', userId: 'u1', createdAt: at(1), media: media('m1') },
      { id: 'b', userId: 'u1', createdAt: at(1), media: media('m2') },
    ];

    const page1 = await service.getFeed('u1', undefined, 1);
    expect(page1.items.map((i) => i.id)).toEqual(['fav:b']);

    const page2 = await service.getFeed('u1', page1.nextCursor, 1);
    expect(page2.items.map((i) => i.id)).toEqual(['fav:a']);
  });

  it('maps episode-scoped rows to the parent show with season/episode numbers', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    const showMedia = media('s1', 'SHOW');
    prisma._episodes = [
      {
        id: 'e1',
        number: 5,
        season: { number: 2, show: { media: showMedia } },
      },
    ];
    prisma._ratings = [
      { id: 'r1', userId: 'u1', episodeId: 'e1', mediaId: null, rating: 4, createdAt: at(3) },
    ];
    prisma._reactions = [
      {
        id: 're1',
        userId: 'u1',
        episodeId: 'e1',
        mediaId: null,
        reaction: 'AMUSED',
        createdAt: at(2),
      },
    ];
    prisma._comments = [
      {
        id: 'c1',
        userId: 'u1',
        threadType: 'EPISODE',
        threadId: 'e1',
        body: 'what an ending',
        isSpoiler: false,
        createdAt: at(1),
      },
    ];

    const res = await service.getFeed('u1');

    expect(res.items).toHaveLength(3);
    for (const item of res.items) {
      expect(item.media).toMatchObject({ id: 's1', type: 'SHOW', title: 'Title s1', year: 2020 });
      expect(item.detail).toMatchObject({ seasonNumber: 2, episodeNumber: 5 });
    }
    expect(res.items[0].detail).toMatchObject({ rating: 4 });
    expect(res.items[1].detail).toMatchObject({ reaction: 'AMUSED' });
    expect(res.items[2].detail).toMatchObject({ excerpt: 'what an ending' });
  });

  it('maps movie rows with movie year and no episode detail', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    prisma._history = [
      { id: 'h1', userId: 'u1', mediaType: 'MOVIE', watchedAt: at(1), media: media('m1') },
    ];

    const res = await service.getFeed('u1');

    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      type: 'WATCHED',
      media: { id: 'm1', type: 'MOVIE', year: 2021 },
    });
    expect(res.items[0].detail).toBeUndefined();
  });

  it('includes season/episode numbers for show watch-history rows', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    prisma._history = [
      {
        id: 'h1',
        userId: 'u1',
        mediaType: 'SHOW',
        seasonNumber: 1,
        episodeNumber: 3,
        watchedAt: at(1),
        media: media('s1', 'SHOW'),
      },
    ];

    const res = await service.getFeed('u1');

    expect(res.items[0].type).toBe('WATCHED');
    expect(res.items[0].detail).toEqual({ seasonNumber: 1, episodeNumber: 3 });
  });

  it('rejects a malformed cursor', async () => {
    const { service, prisma } = makeService();
    prisma._users = [userRow('u1')];
    await expect(service.getFeed('u1', 'not-a-cursor')).rejects.toThrow('Invalid feed cursor');
  });
});
