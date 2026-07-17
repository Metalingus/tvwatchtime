import { classifyTraktFile, isTraktArchive, resolveTraktArchiveLanguage } from './detect';

describe('classifyTraktFile', () => {
  it('classifies watched history/shows/movies (incl. numbered pages)', () => {
    expect(classifyTraktFile('watched-history-1.json')).toBe('watched_history');
    expect(classifyTraktFile('watched-history-27.json')).toBe('watched_history');
    expect(classifyTraktFile('watched-shows-1.json')).toBe('watched_shows');
    expect(classifyTraktFile('watched-movies-1.json')).toBe('watched_movies');
  });

  it('classifies ratings files', () => {
    expect(classifyTraktFile('ratings-episodes.json')).toBe('ratings_episode');
    expect(classifyTraktFile('ratings-shows.json')).toBe('ratings_show');
    expect(classifyTraktFile('ratings-movies.json')).toBe('ratings_movie');
    expect(classifyTraktFile('ratings-seasons.json')).toBe('ratings_season');
  });

  it('classifies watchlist, favorites, lists, comments, and settings files', () => {
    expect(classifyTraktFile('lists-watchlist.json')).toBe('watchlist');
    expect(classifyTraktFile('lists-favorites.json')).toBe('favorites');
    expect(classifyTraktFile('lists-lists.json')).toBe('lists');
    expect(classifyTraktFile('comments-episodes.json')).toBe('comments_episode');
    expect(classifyTraktFile('comments-movies.json')).toBe('comments_movie');
    expect(classifyTraktFile('comments-shows.json')).toBe('comments_show');
    expect(classifyTraktFile('comments-seasons.json')).toBe('comments_season');
    expect(classifyTraktFile('comments-lists.json')).toBe('comments_list');
    expect(classifyTraktFile('user-settings.json')).toBe('user_settings');
  });

  it('strips directories and is case-insensitive', () => {
    expect(classifyTraktFile('some/dir/watched-history-3.json')).toBe('watched_history');
    expect(classifyTraktFile('Watched-Shows-1.JSON')).toBe('watched_shows');
    expect(classifyTraktFile('C:\\exports\\Ratings-Movies.json')).toBe('ratings_movie');
    expect(classifyTraktFile('TRAKT/Lists-Watchlist.JSON')).toBe('watchlist');
  });

  it('marks known-but-unsupported and unknown files as unsupported', () => {
    const unsupported = [
      'watched-playback.json',
      'collection-episodes.json',
      'collection-movies.json',
      'hidden-calendar.json',
      'likes-comments.json',
      'likes-lists.json',
      'network-followers.json',
      'notes-movies.json',
      'user-profile.json',
      'user-stats.json',
      'user-last-activities.json',
      'lists-collaborations.json',
      'random.json',
      'seen_episode_source.csv',
    ];
    for (const f of unsupported) {
      expect(classifyTraktFile(f)).toBe('unsupported');
    }
  });
});

describe('isTraktArchive', () => {
  it('is true for a Trakt export file list', () => {
    expect(
      isTraktArchive(['watched-history-1.json', 'ratings-shows.json', 'user-settings.json']),
    ).toBe(true);
    expect(isTraktArchive(['user-profile.json'])).toBe(true);
    expect(isTraktArchive(['comments-shows.json'])).toBe(true);
    expect(isTraktArchive(['lists-lists.json'])).toBe(true);
  });

  it('detects Trakt files inside subfolders', () => {
    expect(isTraktArchive(['export/json/watched-movies-1.json'])).toBe(true);
  });

  it('is false for TV Time CSV exports and empty lists', () => {
    expect(
      isTraktArchive(['seen_episode_source.csv', 'tracking-prod-records.csv', 'user.csv']),
    ).toBe(false);
    expect(isTraktArchive([])).toBe(false);
  });

  it('ignores non-json files', () => {
    expect(isTraktArchive(['watched-history-notes.txt'])).toBe(false);
    expect(isTraktArchive(['ratings-readme.md'])).toBe(false);
  });
});

describe('resolveTraktArchiveLanguage', () => {
  it('resolves exact locales', () => {
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'en' } })).toBe('en');
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'fr' } })).toBe('fr');
  });

  it('falls back to the base language for regional variants', () => {
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'fr-fr' } })).toBe('fr');
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'es_MX' } })).toBe('es');
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'FR-FR' } })).toBe('fr');
  });

  it('returns null for garbage, system, or missing values', () => {
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'xx-yy' } })).toBeNull();
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 'system' } })).toBeNull();
    expect(resolveTraktArchiveLanguage({ browsing: { locale: '' } })).toBeNull();
    expect(resolveTraktArchiveLanguage({ browsing: { locale: 42 } })).toBeNull();
    expect(resolveTraktArchiveLanguage({ browsing: {} })).toBeNull();
    expect(resolveTraktArchiveLanguage({})).toBeNull();
    expect(resolveTraktArchiveLanguage(null)).toBeNull();
    expect(resolveTraktArchiveLanguage('en')).toBeNull();
  });
});
