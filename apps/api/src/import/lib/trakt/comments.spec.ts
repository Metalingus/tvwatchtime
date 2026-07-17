import { classifyTraktFile } from './detect';
import { normalizeTraktComments } from './comments';

const SHOW = {
  title: 'SpongeBob SquarePants',
  year: 1999,
  ids: { trakt: 386, slug: 'spongebob-squarepants', tvdb: 75886, imdb: 'tt0206512', tmdb: 387 },
};

const EPISODE = {
  season: 7,
  number: 50,
  title: 'Love That Squid',
  ids: { trakt: 4940040, tvdb: 3448811, imdb: null, tmdb: 1249456 },
};

const file = (filename: string, data: unknown) => ({
  filename,
  kind: classifyTraktFile(filename),
  data,
});

const epComment = (over: Record<string, unknown> = {}) => ({
  id: 123456,
  parent_id: 0,
  comment: 'This episode was great!',
  spoiler: false,
  review: false,
  created_at: '2024-03-01T12:00:00.000Z',
  updated_at: '2024-03-02T12:00:00.000Z',
  episode: EPISODE,
  show: SHOW,
  ...over,
});

describe('normalizeTraktComments — filtering', () => {
  it('skips replies (parent_id truthy)', () => {
    const r = normalizeTraktComments([
      file('comments-episodes.json', [epComment(), epComment({ id: 2, parent_id: 123456 })]),
    ]);
    expect(r.rowsDetected).toBe(2);
    expect(r.repliesSkipped).toBe(1);
    expect(r.candidates).toHaveLength(1);
  });

  it('marks empty/whitespace text and missing id as invalid', () => {
    const r = normalizeTraktComments([
      file('comments-episodes.json', [
        epComment({ id: 10, comment: '   ' }),
        epComment({ id: 11, comment: '' }),
        epComment({ id: null }),
        'garbage',
      ]),
    ]);
    expect(r.invalid).toBe(4);
    expect(r.candidates).toHaveLength(0);
  });

  it('ignores season/list comment files entirely', () => {
    const r = normalizeTraktComments([
      file('comments-seasons.json', [{ id: 1, comment: 'season note' }]),
      file('comments-lists.json', [{ id: 2, comment: 'list note' }]),
    ]);
    expect(r.rowsDetected).toBe(0);
    expect(r.candidates).toHaveLength(0);
  });

  it('episode comments require show title + season + number', () => {
    const r = normalizeTraktComments([
      file('comments-episodes.json', [
        epComment({ id: 1, show: { year: 1999, ids: SHOW.ids } }), // no title
        epComment({ id: 2, episode: { number: 50, ids: EPISODE.ids } }), // no season
        epComment({ id: 3, episode: { season: 7, ids: EPISODE.ids } }), // no number
      ]),
    ]);
    expect(r.invalid).toBe(3);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('normalizeTraktComments — normalization', () => {
  it('normalizes an episode comment with ids, spoiler flag, and dates', () => {
    const r = normalizeTraktComments([
      file('comments-episodes.json', [epComment({ spoiler: true })]),
    ]);
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.comment.targetType).toBe('episode');
    expect(c.comment.sourceFile).toBe('comments-episodes.json');
    expect(c.comment.sourceRow).toBe(1);
    expect(c.comment.sourceCommentId).toBe('123456'); // stringified
    expect(c.comment.sourceAuthorId).toBeNull();
    expect(c.comment.text).toBe('This episode was great!');
    expect(c.comment.textLength).toBe('This episode was great!'.length);
    expect(c.comment.spoiler).toBe(true);
    expect(c.comment.language).toBeNull();
    expect(c.comment.image).toBeNull();
    expect(c.comment.sourceCreatedAt?.toISOString()).toBe('2024-03-01T12:00:00.000Z');
    expect(c.comment.sourceUpdatedAt?.toISOString()).toBe('2024-03-02T12:00:00.000Z');
    expect(c.comment.externalEpisodeId).toBe(1249456); // tmdb ?? tvdb
    expect(c.comment.showTitle).toBe('SpongeBob SquarePants');
    expect(c.comment.seasonNumber).toBe(7);
    expect(c.comment.episodeNumber).toBe(50);
    expect(c.showIds?.trakt).toBe(386);
    expect(c.episodeIds?.trakt).toBe(4940040);
  });

  it('preserves untrimmed original text', () => {
    const r = normalizeTraktComments([
      file('comments-shows.json', [
        {
          id: 7,
          parent_id: null,
          comment: '  padded  ',
          spoiler: 0,
          created_at: null,
          updated_at: null,
          show: SHOW,
        },
      ]),
    ]);
    expect(r.candidates[0].comment.text).toBe('  padded  ');
    expect(r.candidates[0].comment.textLength).toBe(10);
    expect(r.candidates[0].comment.targetType).toBe('show');
  });

  it('imports review === true rows as comments', () => {
    const r = normalizeTraktComments([
      file('comments-movies.json', [
        {
          id: 99,
          parent_id: null,
          comment: 'A long-form review.',
          spoiler: false,
          review: true,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: null,
          movie: { title: 'Flow', year: 2024, ids: { trakt: 656016, tmdb: 823219 } },
        },
      ]),
    ]);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].comment.targetType).toBe('movie');
    expect(r.candidates[0].comment.movieTitle).toBe('Flow');
    expect(r.candidates[0].movieIds?.tmdb).toBe(823219);
  });

  it('tolerates non-object rows, missing dates, and empty files', () => {
    const r = normalizeTraktComments([
      file('comments-episodes.json', []),
      file('comments-shows.json', [null, 42]),
      file('comments-movies.json', 'not-an-array'),
    ]);
    expect(r.rowsDetected).toBe(2);
    expect(r.invalid).toBe(2);
    expect(r.candidates).toHaveLength(0);
  });
});
