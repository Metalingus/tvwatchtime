import { MediaType } from '@tvwatch/shared';
import { reconcileCollapsedWatchRows, topGenresByDistinctTitles } from './stats.service';

describe('topGenresByDistinctTitles', () => {
  it('counts genres once per title instead of once per episode or rewatch', () => {
    const show = {
      mediaId: 'show-1',
      media: {
        genres: [{ genre: { name: 'Drama' } }, { genre: { name: 'Comedy' } }],
      },
    };

    expect(
      topGenresByDistinctTitles([
        show,
        show,
        show,
        {
          mediaId: 'show-2',
          media: { genres: [{ genre: { name: 'Drama' } }] },
        },
      ]),
    ).toEqual([
      { name: 'Drama', count: 2 },
      { name: 'Comedy', count: 1 },
    ]);
  });
});

describe('reconcileCollapsedWatchRows', () => {
  const mediaShape = (id: string, runtimeMinutes: number) => ({
    id,
    title: id,
    genres: [],
    show: id.startsWith('show') ? { network: null } : null,
    movie: id.startsWith('movie') ? { runtimeMinutes } : null,
  });

  it('adds only imported plays missing from history and does not double native rewatches', () => {
    const showMedia = mediaShape('show-1', 45);
    const movieMedia = mediaShape('movie-1', 120);
    const watchedAt = new Date('2024-01-01T00:00:00.000Z');
    const showRow = {
      mediaId: showMedia.id,
      mediaType: MediaType.SHOW,
      episodeId: 'episode-1',
      seasonNumber: 1,
      episodeNumber: 1,
      runtimeMinutes: 45,
      watchedAt,
      media: showMedia,
    };
    const movieRow = {
      mediaId: movieMedia.id,
      mediaType: MediaType.MOVIE,
      episodeId: null,
      runtimeMinutes: 120,
      watchedAt,
      media: movieMedia,
    };

    const rows = reconcileCollapsedWatchRows(
      [showRow, showRow, movieRow],
      [
        {
          episodeId: 'episode-1',
          watched: true,
          watchCount: 3,
          watchedAt,
          episode: {
            number: 1,
            runtimeMinutes: 45,
            season: { number: 1, show: { media: showMedia } },
          },
        },
      ],
      [{ mediaId: movieMedia.id, watched: true, watchCount: 2, watchedAt, media: movieMedia }],
    );

    expect(rows.filter((row) => row.mediaType === MediaType.SHOW)).toHaveLength(3);
    expect(rows.filter((row) => row.mediaType === MediaType.MOVIE)).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.runtimeMinutes, 0)).toBe(3 * 45 + 2 * 120);
  });
});
