import { latestWatchByMedia, sortByLatestWatch } from './latest-watch';

const at = (iso: string) => new Date(iso);

describe('latest watch ordering', () => {
  it("uses a show's latest episode and a movie's latest watch including rewatches", async () => {
    const prisma: any = {
      userShowStatus: {
        findMany: jest.fn().mockResolvedValue([
          { mediaId: 'show', lastWatchedAt: at('2026-09-01') },
          { mediaId: 'not-started', lastWatchedAt: null },
        ]),
      },
      userMovieStatus: {
        // watched_at is the FIRST watch; the rewatch is only in watch_history.
        findMany: jest.fn().mockResolvedValue([{ mediaId: 'movie', watchedAt: at('2025-01-01') }]),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ mediaId: 'movie', at: at('2026-09-20') }]),
    };
    const latest = await latestWatchByMedia(prisma, 'u1', ['show', 'not-started', 'movie']);
    expect(latest.get('show')).toBe(at('2026-09-01').getTime());
    expect(latest.get('movie')).toBe(at('2026-09-20').getTime());
    expect(latest.has('not-started')).toBe(false);
    await expect(latestWatchByMedia(prisma, 'u1', [])).resolves.toEqual(new Map());
  });

  it('orders by latest watch, then never-watched titles by date added', () => {
    const rows = [
      { id: 'a', mediaId: 'old-watch', addedAt: at('2026-09-10') },
      { id: 'b', mediaId: 'unwatched-new', addedAt: at('2026-09-30') },
      { id: 'c', mediaId: 'recent-watch', addedAt: at('2026-01-01') },
      { id: 'd', mediaId: 'unwatched-old', addedAt: at('2026-02-01') },
    ];
    const latest = new Map([
      ['old-watch', at('2026-03-01').getTime()],
      ['recent-watch', at('2026-09-29').getTime()],
    ]);
    expect(sortByLatestWatch(rows, latest).map((r) => r.mediaId)).toEqual([
      'recent-watch',
      'old-watch',
      'unwatched-new',
      'unwatched-old',
    ]);
  });
});
