import * as fs from 'fs';
import * as path from 'path';
import { classifyTvTimeJsonFile, isTvTimeJsonArchive } from './lib/tvtime-json/detect';
import { normalizeTvTimeJsonShows } from './lib/tvtime-json/shows';
import { normalizeTvTimeJsonMovies } from './lib/tvtime-json/movies';
import { normalizeTvTimeJsonFavorites } from './lib/tvtime-json/favorites';
import { normalizeTvTimeJsonLists } from './lib/tvtime-json/lists';
import { normalizeTvTimeJsonRatings } from './lib/tvtime-json/ratings';
import { normalizeTvTimeWatchlistCsv } from './lib/tvtime-json/activity';
import { parseCsv } from './lib/csv';

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/tvtime-json');

function loadAll(): { filename: string; kind: ReturnType<typeof classifyTvTimeJsonFile> }[] {
  return fs.readdirSync(FIXTURE_DIR).map((filename) => ({ filename, kind: classifyTvTimeJsonFile(filename) }));
}

function loadJson(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

describe('tvtime-json import pipeline (fixtures, no DB)', () => {
  it('detects the archive and classifies every fixture file', () => {
    const files = loadAll();
    expect(isTvTimeJsonArchive(files.map((f) => f.filename))).toBe(true);
    const byKind = new Map(files.map((f) => [f.filename, f.kind]));
    expect(byKind.get('shows.json')).toBe('shows');
    expect(byKind.get('movies.json')).toBe('movies');
    expect(byKind.get('favorites.json')).toBe('favorites');
    expect(byKind.get('lists.json')).toBe('lists');
    expect(byKind.get('activity_history.csv')).toBe('activity_csv');
    // flattened CSV duplicates are intentionally ignored
    expect(byKind.get('favorites.csv')).toBe('ignored_csv');
    expect(byKind.get('list_kdramas_.csv')).toBe('ignored_csv');
  });

  it('normalizes watched episodes with specials flagged and a non-special footprint', () => {
    const res = normalizeTvTimeJsonShows(loadJson('shows.json'));
    expect(res.invalid).toBe(0);
    expect(res.episodes).toHaveLength(3); // 2 regular + 1 special; unwatched S1E3 excluded
    expect(res.episodes.filter((e) => e.special)).toHaveLength(1);
    const fp = res.footprints.get('tvdb:328638')!;
    expect(fp.seasonEpisodes).toEqual([{ season: 1, maxEpisode: 3 }]); // special E9 excluded
    expect(res.footprints.get('tvdb:367083')!.showTitle).toBe('Hospital Playlist');
  });

  it('splits movies into watched and watchlist', () => {
    const res = normalizeTvTimeJsonMovies(loadJson('movies.json'));
    expect(res.watched).toHaveLength(2);
    expect(res.watchlist).toHaveLength(1);
    expect(res.watchlist[0].title).toBe('The Ritual Killer');
  });

  it('harvests ratings from all JSON sources, deduped by episode id', () => {
    const res = normalizeTvTimeJsonRatings({
      shows: [loadJson('shows.json')],
      movies: [loadJson('movies.json')],
      collections: [loadJson('favorites.json'), loadJson('lists.json')],
    });
    expect(res.detected).toBe(4); // shows 1 + movies 1 + favorites dup 1 + lists unique 1
    expect(res.candidates).toHaveLength(3);
    expect(res.candidates.find((c) => c.episodeIds?.tvdb === 6492386)!.rating.normalizedRating).toBe(5);
    expect(res.candidates.find((c) => c.movieIds?.tvdb === 340843)!.rating.normalizedRating).toBe(4);
    // unique to lists.json (episode unrated/absent in shows.json)
    expect(res.candidates.find((c) => c.episodeIds?.tvdb === 7575530)!.rating.normalizedRating).toBe(3);
  });

  it('extracts show watchlist flags from activity_history.csv only (quoted titles, deduped)', () => {
    const csv = parseCsv(fs.readFileSync(path.join(FIXTURE_DIR, 'activity_history.csv')));
    const res = normalizeTvTimeWatchlistCsv(csv.rows);
    expect(res.candidates).toHaveLength(3);
    expect(res.candidates.map((c) => c.title)).toContain('Suits, avocats sur mesure');
    expect(res.candidates.every((c) => c.type === 'show')).toBe(true);
  });

  it('normalizes favorites and lists (visibility respected, stable sourceKeys)', () => {
    const favs = normalizeTvTimeJsonFavorites(loadJson('favorites.json'));
    expect(favs.candidates).toHaveLength(1);
    expect(favs.candidates[0]).toMatchObject({ type: 'show', title: 'Deception', year: 2018 });

    const lists = normalizeTvTimeJsonLists(loadJson('lists.json'));
    expect(lists.lists).toHaveLength(1);
    expect(lists.lists[0].visibility).toBe('PUBLIC');
    expect(lists.lists[0].sourceKey).toBe('tvtime:list:kdramas');
    expect(lists.lists[0].items.map((i) => i.title)).toEqual(['Hospital Playlist', 'Lovely Runner']);
  });
});
