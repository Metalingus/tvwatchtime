import * as fs from 'fs';
import * as path from 'path';
import { classifyTraktFile, isTraktArchive } from './lib/trakt/detect';
import { normalizeTraktWatched } from './lib/trakt/watched';
import { normalizeTraktRatings } from './lib/trakt/ratings';
import { normalizeTraktWatchlist, normalizeTraktFavorites } from './lib/trakt/lists';

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/trakt');

function loadAll(): { filename: string; kind: ReturnType<typeof classifyTraktFile>; data: unknown }[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((filename) => ({
      filename,
      kind: classifyTraktFile(filename),
      data: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, filename), 'utf8')),
    }));
}

describe('trakt import pipeline (fixtures, no DB)', () => {
  it('detects the archive as Trakt and classifies every fixture', () => {
    const files = loadAll();
    expect(isTraktArchive(files.map((f) => f.filename))).toBe(true);
    const kinds = files.map((f) => f.kind).sort();
    expect(kinds).toEqual(['favorites', 'ratings_show', 'watched_history', 'watchlist'].sort());
  });

  it('collapses watched history per episode/movie (earliest watchedAt, play count)', () => {
    const files = loadAll();
    const watched = normalizeTraktWatched({
      history: files.filter((f) => f.kind === 'watched_history').map((f) => f.data),
      watchedMovies: [],
      watchedShows: [],
    });
    expect(watched.invalid).toBe(0);
    expect(watched.skippedNoEpisodeData).toBe(0);
    expect(watched.episodes).toHaveLength(2);
    expect(watched.movies).toHaveLength(1);

    const e50 = watched.episodes.find((e) => e.episode === 50)!;
    expect(e50.watchCount).toBe(2); // two plays of S7E50 collapsed
    expect(e50.watchedAt?.toISOString()).toBe('2024-05-01T10:00:00.000Z'); // earliest play wins
    expect(e50.showIds.trakt).toBe(386);
    expect(e50.episodeIds.tmdb).toBe(1249456);

    const e43 = watched.episodes.find((e) => e.episode === 43)!;
    expect(e43.watchCount).toBe(1);

    expect(watched.movies[0].movieTitle).toBe("Carlito's Way");
    expect(watched.movies[0].movieIds.tmdb).toBe(6075);
  });

  it('converts Trakt 1–10 ratings into the 1–5 model with stable voteKeys', () => {
    const res = normalizeTraktRatings(loadAll());
    expect(res.detected).toBe(2);
    expect(res.unsupported).toBe(0);
    const byTitle = new Map(res.candidates.map((c) => [c.rating.showTitle, c]));
    expect(byTitle.get('SpongeBob SquarePants')!.rating.normalizedRating).toBe(5); // 10 → 5
    expect(byTitle.get('Dragon Ball Super')!.rating.normalizedRating).toBe(4); // 7 → 4
    expect(byTitle.get('SpongeBob SquarePants')!.rating.voteKey).toBe('trakt:show:386');
  });

  it('keeps show/movie watchlist rows and skips other types', () => {
    const files = loadAll();
    const res = normalizeTraktWatchlist(files.find((f) => f.kind === 'watchlist')!.data);
    expect(res.candidates).toHaveLength(2);
    expect(res.skipped).toBe(1); // the person row
    const show = res.candidates.find((c) => c.type === 'show')!;
    expect(show.title).toBe('SpongeBob SquarePants');
    expect(show.rank).toBe(1);
    expect(show.listedAt?.toISOString()).toBe('2024-07-16T01:08:46.000Z');
  });

  it('keeps show/movie favorite rows and skips other types', () => {
    const files = loadAll();
    const res = normalizeTraktFavorites(files.find((f) => f.kind === 'favorites')!.data);
    expect(res.candidates).toHaveLength(2);
    expect(res.skipped).toBe(1); // the person row
    expect(res.candidates.find((c) => c.type === 'movie')!.title).toBe("Carlito's Way");
    const show = res.candidates.find((c) => c.type === 'show')!;
    expect(show.title).toBe('The Big Bang Theory');
    expect(show.ids.tvdb).toBe(80379);
  });
});
