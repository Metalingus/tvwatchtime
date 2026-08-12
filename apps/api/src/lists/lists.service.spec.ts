import { ListVisibility } from '@prisma/client';
import { ListsService } from './lists.service';

describe('ListsService', () => {
  it('annotates list items with the visiting user library state', async () => {
    const customList = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'list-1',
        userId: 'owner-1',
        visibility: ListVisibility.PUBLIC,
      }),
    };
    const customListItem = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'item-movie',
          mediaId: 'movie-1',
          media: {
            type: 'MOVIE',
            title: 'Movie',
            posterUrl: '/movie.jpg',
            backdropUrl: null,
            rating: 8,
            show: null,
            movie: { releaseYear: 2024 },
            watchlist: [{ id: 'watchlist-1' }],
            movieStatuses: [{ watched: true }],
          },
        },
        {
          id: 'item-show',
          mediaId: 'show-1',
          media: {
            type: 'SHOW',
            title: 'Show',
            posterUrl: '/show.jpg',
            backdropUrl: null,
            rating: 7,
            show: { yearStart: 2023 },
            movie: null,
            watchlist: [],
            movieStatuses: [],
          },
        },
      ]),
      count: jest.fn().mockResolvedValue(2),
    };
    const service = new ListsService({ customList, customListItem } as any, {} as any);

    const result = await service.getItems('list-1', 'viewer-1');

    expect(customListItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          media: {
            include: expect.objectContaining({
              watchlist: {
                where: { userId: 'viewer-1' },
                select: { id: true },
              },
              movieStatuses: {
                where: { userId: 'viewer-1' },
                select: { watched: true },
              },
            }),
          },
        },
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({
        mediaId: 'movie-1',
        inWatchlist: true,
        watched: true,
      }),
      expect.objectContaining({
        mediaId: 'show-1',
        inWatchlist: false,
        watched: false,
      }),
    ]);
  });
});
