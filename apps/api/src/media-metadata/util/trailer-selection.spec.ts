import { selectTmdbTrailer, selectTvdbTrailer, type TmdbVideo } from './trailer-selection';

const odyssey: TmdbVideo[] = [
  {
    site: 'YouTube',
    key: 'TMtYbo_pJo8',
    type: 'Featurette',
    official: true,
    name: 'Nolan and IMAX',
  },
  {
    site: 'YouTube',
    key: 'aUWTVfwdm-c',
    type: 'Teaser',
    official: true,
    name: 'The EPIC journey of The Odyssey will be back in IMAX this FRIDAY',
    published_at: '2026-08-20T17:05:04Z',
  },
  {
    site: 'YouTube',
    key: 'AyIZ9tiiN8I',
    type: 'Trailer',
    official: true,
    name: 'Official Countdown Trailer',
    published_at: '2026-07-01T12:30:05Z',
  },
  {
    site: 'YouTube',
    key: 'f_bKjZeJBBI',
    type: 'Trailer',
    official: true,
    name: 'Official New Trailer',
    published_at: '2026-05-05T04:10:02Z',
  },
  {
    site: 'YouTube',
    key: 'Mzw2ttJD2qQ',
    type: 'Trailer',
    official: true,
    name: 'Official Trailer',
    published_at: '2025-12-22T14:00:04Z',
  },
];

it('selects The Odyssey full official trailer instead of its newer IMAX promo', () => {
  expect(selectTmdbTrailer(odyssey)).toBe('https://www.youtube.com/watch?v=f_bKjZeJBBI');
  expect(selectTmdbTrailer([...odyssey].reverse())).toBe(
    'https://www.youtube.com/watch?v=f_bKjZeJBBI',
  );
});

it.each(['Teaser', 'Clip', 'Featurette', 'Behind the Scenes', 'Opening Credits'])(
  'does not label a %s as a trailer when no full trailer exists',
  (type) => {
    expect(selectTmdbTrailer([{ ...odyssey[3], type }])).toBeNull();
  },
);

it('rejects unofficial videos, unknown official status, invalid IDs, and other sites', () => {
  for (const override of [
    { official: false },
    { official: undefined },
    { key: 'bad&list=x' },
    { site: 'Other' },
  ]) {
    expect(selectTmdbTrailer([{ ...odyssey[3], ...override }])).toBeNull();
  }
});

it('rejects explicit teaser-trailer labels despite the broader Trailer type', () => {
  expect(selectTmdbTrailer([{ ...odyssey[3], name: 'Official Teaser Trailer' }])).toBeNull();
});

it('returns no trailer for an empty provider response', () => {
  expect(selectTmdbTrailer()).toBeNull();
  expect(selectTmdbTrailer(null)).toBeNull();
  expect(selectTvdbTrailer()).toBeNull();
  expect(selectTvdbTrailer(null)).toBeNull();
});

it('reads curated TVDB trailers and prefers the requested language', () => {
  const trailers = [
    { language: 'eng', name: 'Trailer', url: 'https://www.youtube.com/watch?v=O9ZJChzPn0U' },
    { language: 'fra', name: 'Trailer', url: 'https://youtu.be/K5mUt32KB9o' },
  ];
  expect(selectTvdbTrailer(trailers, 'fra')).toBe('https://www.youtube.com/watch?v=K5mUt32KB9o');
  expect(selectTvdbTrailer(trailers, 'jpn')).toBe('https://www.youtube.com/watch?v=O9ZJChzPn0U');
});

it('does not open TVDB search pages, playlists, foreign hosts, or obvious promos', () => {
  for (const url of [
    'https://www.youtube.com/results?search_query=trailer',
    'https://www.youtube.com/playlist?list=x',
    'https://example.com/watch?v=O9ZJChzPn0U',
  ]) {
    expect(selectTvdbTrailer([{ name: 'Trailer', url }])).toBeNull();
  }
  expect(
    selectTvdbTrailer([{ name: 'Official Teaser', url: 'https://youtu.be/O9ZJChzPn0U' }]),
  ).toBeNull();
});
