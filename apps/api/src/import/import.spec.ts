import { inspectZip } from './lib/zip-validator';
import { detectProfile, normalizeRow, normTitle, parseDate, splitTitleYear } from './lib/inference';
import { UnsafeArchiveError, InvalidUploadError } from './errors';

// Minimal valid ZIP (1 csv entry "a.csv" containing "h1\nv1") created with adm-zip.
import AdmZip from 'adm-zip';
function zipOne(name: string, content: string): Buffer {
  const z = new AdmZip();
  z.addFile(name, Buffer.from(content, 'utf8'));
  return z.toBuffer();
}

describe('import zip-validator', () => {
  it('accepts a CSV-only zip and lists entries', () => {
    const { entries } = inspectZip(zipOne('seen_episode_source.csv', 'a,b\n1,2'));
    expect(entries.length).toBe(1);
    expect(entries[0].isSupported).toBe(true);
  });

  it('rejects nested zip entries', () => {
    const outer = new AdmZip();
    outer.addFile('inner.zip', Buffer.from('PK'));
    expect(() => inspectZip(outer.toBuffer())).toThrow(UnsafeArchiveError);
  });

  it('rejects invalid zip bytes', () => {
    expect(() => inspectZip(Buffer.from('not a zip'))).toThrow(InvalidUploadError);
  });
});

describe('import inference', () => {
  it('detects TVTime watched-episode profile by filename', () => {
    expect(detectProfile('seen_episode_source.csv', ['episode_id', 'tv_show_name'])).toBe('tvtime_watched_episode');
  });
  it('detects user_tv_show_data profile', () => {
    expect(detectProfile('user_tv_show_data.csv', ['user_id', 'is_followed'])).toBe('tvtime_show_data');
  });
  it('detects generic episode profile from headers', () => {
    expect(detectProfile('x.csv', ['title', 'season', 'episode'])).toBe('generic_episode');
  });

  it('normalizes a watched episode row', () => {
    const items = normalizeRow('tvtime_watched_episode', {
      tv_show_name: 'FROM',
      episode_season_number: '1',
      episode_number: '4',
      created_at: '2021-06-10 20:00:00',
    });
    expect(items.length).toBe(1);
    expect(items[0].entityType).toBe('WATCHED_EPISODE');
    expect(items[0].season).toBe(1);
    expect(items[0].episode).toBe(4);
    expect(items[0].watchedAt?.getFullYear()).toBe(2021);
  });

  it('emits watchlist + favorite from user_tv_show_data', () => {
    const items = normalizeRow('tvtime_show_data', {
      tv_show_name: 'The Office (US)',
      is_followed: '1',
      is_favorited: '1',
    });
    expect(items.map((i) => i.entityType).sort()).toEqual(['FAVORITE_SHOW', 'WATCHLIST_SHOW']);
  });

  it('skips rows missing season/episode', () => {
    expect(normalizeRow('tvtime_watched_episode', { tv_show_name: 'X', episode_season_number: '', episode_number: '' })).toHaveLength(0);
  });

  it('splits a year out of a title', () => {
    const { title, year } = splitTitleYear('Hunters (2020)');
    expect(title).toBe('Hunters');
    expect(year).toBe(2020);
  });

  it('normalizes titles for matching', () => {
    expect(normTitle('The Office (US)!')).toBe('the office us');
    expect(normTitle('Mr. Robot')).toBe('mr robot');
  });

  describe('tvtime_tracking', () => {
    it('classifies the file by filename', () => {
      expect(detectProfile('tracking-prod-records.csv', [])).toBe('tvtime_tracking');
      expect(detectProfile('tracking-prod-records-v2.csv', [])).toBe('tvtime_tracking');
    });

    it('parses a v1 watched-episode row (epoch-seconds watch_date)', () => {
      const items = normalizeRow('tvtime_tracking', {
        type: 'watch',
        series_name: 'The Blacklist',
        season_number: '6',
        episode_number: '17',
        watch_date: '1616481927',
      });
      expect(items).toHaveLength(1);
      expect(items[0].entityType).toBe('WATCHED_EPISODE');
      expect(items[0].season).toBe(6);
      expect(items[0].watchedAt?.getTime()).toBe(1616481927000);
    });

    it('parses a v1 watched-movie row', () => {
      const items = normalizeRow('tvtime_tracking', { type: 'watch', movie_name: 'Fury' });
      expect(items[0].entityType).toBe('WATCHED_MOVIE');
    });

    it('parses a v1 follow movie → watchlist', () => {
      const items = normalizeRow('tvtime_tracking', { type: 'follow', movie_name: 'What Happened to Monday' });
      expect(items[0].entityType).toBe('WATCHLIST_MOVIE');
    });

    it('parses a v1 towatch show → watchlist', () => {
      const items = normalizeRow('tvtime_tracking', { type: 'towatch', series_name: 'FROM' });
      expect(items[0].entityType).toBe('WATCHLIST_SHOW');
    });

    it('parses v2 aggregate is_followed → watchlist (no type column)', () => {
      const items = normalizeRow('tvtime_tracking', { series_name: 'The Office (US)', is_followed: '1', ep_watch_count: '120' });
      expect(items[0].entityType).toBe('WATCHLIST_SHOW');
    });

    it('parses last-episode-watched with epoch watch_date', () => {
      const items = normalizeRow('tvtime_tracking', {
        type: 'last-episode-watched',
        series_name: 'Capitani',
        season_number: '1',
        episode_number: '12',
        watch_date: '1630729488',
        runtime: '1620',
      });
      expect(items[0].entityType).toBe('WATCHED_EPISODE');
      expect(items[0].watchedAt?.getTime()).toBe(1630729488000);
    });

    it('ignores aggregate count rows', () => {
      expect(normalizeRow('tvtime_tracking', { type: 'count-watch-episode-series', series_name: 'X', watch_count: '5' })).toHaveLength(0);
    });
  });

  describe('parseDate', () => {
    it('handles epoch seconds, ms, datetime and 0001 sentinel', () => {
      expect(parseDate('1616481927')?.getTime()).toBe(1616481927000);
      expect(parseDate('1616481927000')?.getTime()).toBe(1616481927000);
      expect(parseDate('2021-03-23 04:45:27')?.getFullYear()).toBe(2021);
      expect(parseDate('0001-01-01 00:00:00')).toBeNull();
      expect(parseDate('')).toBeNull();
    });
  });
});
