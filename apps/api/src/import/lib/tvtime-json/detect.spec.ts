import { classifyTvTimeJsonFile, isTvTimeJsonArchive, isTvTimeJsonStandaloneFile } from './detect';
import { isTraktArchive } from '../trakt/detect';

describe('tvtime-json detect', () => {
  it('classifies the export files by basename', () => {
    expect(classifyTvTimeJsonFile('shows.json')).toBe('shows');
    expect(classifyTvTimeJsonFile('movies.json')).toBe('movies');
    expect(classifyTvTimeJsonFile('favorites.json')).toBe('favorites');
    expect(classifyTvTimeJsonFile('lists.json')).toBe('lists');
    expect(classifyTvTimeJsonFile('activity_history.csv')).toBe('activity_csv');
  });

  it('treats every other CSV as an ignored flattened duplicate', () => {
    expect(classifyTvTimeJsonFile('favorites.csv')).toBe('ignored_csv');
    expect(classifyTvTimeJsonFile('list_kdramas_.csv')).toBe('ignored_csv');
    expect(classifyTvTimeJsonFile('list_my shows.csv')).toBe('ignored_csv');
    expect(classifyTvTimeJsonFile('seen_episode_source.csv')).toBe('ignored_csv');
  });

  it('handles subfolders and case-insensitivity', () => {
    expect(classifyTvTimeJsonFile('GDPR export/Shows.JSON')).toBe('shows');
    expect(classifyTvTimeJsonFile('data\\Movies.json')).toBe('movies');
  });

  it('returns unsupported for unknown files', () => {
    expect(classifyTvTimeJsonFile('readme.txt')).toBe('unsupported');
    expect(classifyTvTimeJsonFile('user.json')).toBe('unsupported');
  });

  it('detects the archive via any marker file', () => {
    expect(isTvTimeJsonArchive(['shows.json', 'movies.json', 'lists.json'])).toBe(true);
    expect(isTvTimeJsonArchive(['activity_history.csv'])).toBe(true);
    expect(isTvTimeJsonArchive(['nested/dir/movies.json'])).toBe(true);
    expect(isTvTimeJsonArchive(['favorites.json', 'lists.json'])).toBe(false);
    expect(isTvTimeJsonArchive(['seen_episode_source.csv', 'followed_tv_show.csv'])).toBe(false);
  });

  it('accepts standalone single-file JSON uploads', () => {
    expect(isTvTimeJsonStandaloneFile('shows.json')).toBe(true);
    expect(isTvTimeJsonStandaloneFile('Lists.JSON')).toBe(true);
    expect(isTvTimeJsonStandaloneFile('activity_history.csv')).toBe(false);
    expect(isTvTimeJsonStandaloneFile('watched-history-1.json')).toBe(false);
  });

  it('does not overlap with Trakt detection in either direction', () => {
    const tvtime = ['shows.json', 'movies.json', 'favorites.json', 'lists.json', 'activity_history.csv'];
    const trakt = ['watched-history-1.json', 'ratings-shows.json', 'lists-watchlist.json', 'lists-lists.json'];
    expect(isTraktArchive(tvtime)).toBe(false);
    expect(isTvTimeJsonArchive(trakt)).toBe(false);
  });
});
