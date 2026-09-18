import { mediaSeedToDetail } from './media-detail-seed';

it('keeps the show ID and title when the only cached seed is Slow Horses episode 1', () => {
  const showId = 'cmrccq6to0yaclf0jx0xyuirn';
  const detail = mediaSeedToDetail(
    {
      id: 'cmrccq7gy0ydmlf0joetlm5vu',
      title: 'Circle of Life',
      showId,
      showTitle: 'Slow Horses',
      rating: 8,
      showImages: { poster: 'show-poster', backdrop: 'show-backdrop' },
    },
    showId,
  );
  expect(detail).toEqual({
    id: showId,
    title: 'Slow Horses',
    yearStart: undefined,
    releaseYear: undefined,
    rating: undefined,
    images: { poster: 'show-poster', backdrop: 'show-backdrop' },
  });
});

it('keeps Watch Next and normal media-card placeholders compatible', () => {
  expect(
    mediaSeedToDetail({ showId: 'show', showTitle: 'Series', posterUrl: 'poster' }, 'show'),
  ).toMatchObject({ id: 'show', title: 'Series', images: { poster: 'poster' } });
  expect(
    mediaSeedToDetail({ id: 'movie', title: 'Film', year: 2026, rating: 7 }, 'movie'),
  ).toMatchObject({ id: 'movie', title: 'Film', yearStart: 2026, rating: 7 });
});
