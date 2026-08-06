import { inspectZip } from './lib/zip-validator';
import {
  detectProfile,
  normalizeNumericExternalId,
  normalizeRow,
  normTitle,
  parseDate,
  splitTitleYear,
} from './lib/inference';
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
    expect(detectProfile('seen_episode_source.csv', ['episode_id', 'tv_show_name'])).toBe(
      'tvtime_watched_episode',
    );
  });
  it('detects TVTime rewatched-episode profile by filename', () => {
    expect(detectProfile('rewatched_episode.csv', ['episode_number', 'cpt', 'tv_show_name'])).toBe(
      'tvtime_rewatched_episode',
    );
  });
  it('detects user_tv_show_data profile', () => {
    expect(detectProfile('user_tv_show_data.csv', ['user_id', 'is_followed'])).toBe(
      'tvtime_show_data',
    );
  });
  it('detects generic episode profile from headers', () => {
    expect(detectProfile('x.csv', ['title', 'season', 'episode'])).toBe('generic_episode');
  });

  it('skips tv_show_rate.csv (owned by the ratings pass — never a watched-movie source)', () => {
    expect(
      detectProfile('tv_show_rate.csv', [
        'user_id',
        'tv_show_id',
        'rating',
        'created_at',
        'tv_show_name',
      ]),
    ).toBe('unknown');
  });

  it('skips TV Time artwork customization files instead of inventing watched movies', () => {
    expect(
      detectProfile('users-customization-prod-data.csv', [
        'series_name',
        'entity_uuid',
        'poster',
        'range_key',
        'updated_at',
        'entity_type',
        'created_at',
        'entity_id',
        'fanart',
      ]),
    ).toBe('unknown');
    expect(
      detectProfile('user_custom_show_image.csv', [
        'updated_at',
        'tv_show_name',
        'tv_show_id',
        'poster_id',
        'fanart_id',
        'created_at',
      ]),
    ).toBe('unknown');
  });

  it('does not treat generic created/updated timestamps as watch evidence', () => {
    expect(detectProfile('movie_metadata.csv', ['movie_name', 'created_at', 'updated_at'])).toBe(
      'unknown',
    );
    expect(detectProfile('show_metadata.csv', ['series_name', 'created_at', 'updated_at'])).toBe(
      'unknown',
    );
  });

  it('still detects generic movie history with an explicit viewing timestamp', () => {
    expect(detectProfile('movie_history.csv', ['movie_name', 'watched_at'])).toBe(
      'generic_movie_watched',
    );
  });

  it('uses file and column identity, not title text, to classify generic watchlists', () => {
    expect(detectProfile('show_watchlist.csv', ['tv_show_name', 'watchlist'])).toBe(
      'generic_watchlist',
    );
    expect(detectProfile('movie_watchlist.csv', ['movie_name', 'watchlist'])).toBe(
      'generic_movie_watchlist',
    );

    const show = normalizeRow('generic_watchlist', {
      tv_show_name: 'Hannah Montana. The Movie',
      tv_show_id: '357187',
      watchlist: '1',
    });
    expect(show).toHaveLength(1);
    expect(show[0]).toMatchObject({
      entityType: 'WATCHLIST_SHOW',
      rawTvdbSeriesId: '357187',
    });
  });

  it('never promotes a TVDB series-column value into a movie identity', () => {
    const movie = normalizeRow('generic_movie_watchlist', {
      movie_name: 'Hannah Montana: The Movie',
      tv_show_id: '357187',
      watchlist: '1',
    });
    expect(movie).toHaveLength(1);
    expect(movie[0]).toMatchObject({
      entityType: 'WATCHLIST_MOVIE',
      rawTvdbSeriesId: null,
    });
  });

  it('profiles match on basename — a folder prefix must not nuke every file', () => {
    // Regression: a zip created from a folder prefixes every entry (gdpr-data/…); the
    // prefix contains the skip word "gdpr", which classified ALL files as unknown and
    // silently skipped the entire watched/watchlist staging (only ratings/emotions/
    // comments survived via their own basename-aware detectors).
    expect(detectProfile('gdpr-data/watched_on_episode.csv', ['episode_id', 'tv_show_name'])).toBe(
      'tvtime_watched_episode',
    );
    expect(detectProfile('gdpr-data/tracking-prod-records.csv', ['type'])).toBe('tvtime_tracking');
    expect(detectProfile('gdpr-data/tracking-prod-records-v2.csv', ['ep_id'])).toBe(
      'tvtime_tracking',
    );
    expect(detectProfile('gdpr-data/rewatched_episode.csv', ['cpt'])).toBe(
      'tvtime_rewatched_episode',
    );
    expect(detectProfile('gdpr-data/user_tv_show_data.csv', ['user_id'])).toBe('tvtime_show_data');
    expect(detectProfile('gdpr-data/followed_tv_show.csv', ['user_id'])).toBe('tvtime_followed');
    // …while the skip list still works on real basenames
    expect(detectProfile('gdpr-data/gdpr_requests.csv', ['id'])).toBe('unknown');
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

  it('normalizes a rewatched-episode row and carries its total watch count', () => {
    const items = normalizeRow('tvtime_rewatched_episode', {
      tv_show_name: 'The King of Queens',
      episode_season_number: '1',
      episode_number: '1',
      cpt: '4',
      updated_at: '2023-09-17 19:47:22',
    });
    expect(items.length).toBe(1);
    expect(items[0].entityType).toBe('WATCHED_EPISODE');
    expect(items[0].season).toBe(1);
    expect(items[0].episode).toBe(1);
    expect(items[0].watchCount).toBe(4);
    expect(items[0].watchedAt?.getFullYear()).toBe(2023);
  });

  it('defaults a rewatched-episode row without cpt to a single watch', () => {
    const items = normalizeRow('tvtime_rewatched_episode', {
      tv_show_name: 'The King of Queens',
      episode_season_number: '1',
      episode_number: '1',
    });
    expect(items[0].watchCount).toBe(1);
  });

  it('v2 watch-episode summary row carries rewatch_count + 1 as the watch tally', () => {
    // tracking-prod-records-v2.csv: Pokémon S01E01 — the watch-episode summary row
    // says rewatch_count=3, so the episode was watched 4 times in total.
    const items = normalizeRow('tvtime_tracking', {
      series_name: 'Pokémon',
      season_number: '1',
      episode_number: '1',
      key: 'watch-episode-705bbee5-95e3-40bc-994e-630ae8a75f27-592c9fbc-c60c-4d35-86bd-28fae8293ec2',
      rewatch_count: '3',
      created_at: '2019-06-08 21:08:37',
    });
    expect(items.length).toBe(1);
    expect(items[0].entityType).toBe('WATCHED_EPISODE');
    expect(items[0].watchCount).toBe(4);
  });

  it('v2 rewatch-episode event rows carry their key ordinal + 1 (covers missing summary counts)', () => {
    // Same episode, third rewatch event row: ordinal 3 → watched 4 times.
    const items = normalizeRow('tvtime_tracking', {
      series_name: 'Pokémon',
      season_number: '1',
      episode_number: '1',
      key: 'rewatch-episode-705bbee5-95e3-40bc-994e-630ae8a75f27-592c9fbc-c60c-4d35-86bd-28fae8293ec2-3',
      created_at: '2025-06-07 17:08:55',
    });
    expect(items.length).toBe(1);
    expect(items[0].watchCount).toBe(4);
  });

  it('v2 per-episode row without any rewatch signal stays a single watch', () => {
    const items = normalizeRow('tvtime_tracking', {
      series_name: 'Pokémon',
      season_number: '1',
      episode_number: '5',
      key: 'watch-episode-705bbee5-95e3-40bc-994e-630ae8a75f27-592c9fbc-c60c-4d35-86bd-28fae8293ec2',
      created_at: '2019-06-08 21:08:37',
    });
    expect(items[0].watchCount).toBe(1);
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
    expect(
      normalizeRow('tvtime_watched_episode', {
        tv_show_name: 'X',
        episode_season_number: '',
        episode_number: '',
      }),
    ).toHaveLength(0);
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

  it('keeps non-Latin scripts distinct (no empty-norm collisions)', () => {
    // The Yatterman incident: an ASCII-only class normalized every non-Latin title to
    // the same '', so bulk by-title resolves matched dozens of unrelated items.
    expect(normTitle('승리호')).not.toBe('');
    expect(normTitle('승리호')).not.toBe(normTitle('소울메이트'));
    expect(normTitle('聲の形')).not.toBe(normTitle('승리호'));
    expect(normTitle('രോമാഞ്ചം')).not.toBe('');
    // Latin behavior unchanged.
    expect(normTitle('7. Koğuştaki Mucize')).toBe('7 kogustaki mucize');
    // Only truly letter-less titles produce an empty norm.
    expect(normTitle('???')).toBe('');
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
      const items = normalizeRow('tvtime_tracking', {
        type: 'follow',
        movie_name: 'What Happened to Monday',
      });
      expect(items[0].entityType).toBe('WATCHLIST_MOVIE');
    });

    it('parses a v1 towatch show → watchlist', () => {
      const items = normalizeRow('tvtime_tracking', { type: 'towatch', series_name: 'FROM' });
      expect(items[0].entityType).toBe('WATCHLIST_SHOW');
    });

    it('parses v2 aggregate is_followed → watchlist (no type column)', () => {
      const items = normalizeRow('tvtime_tracking', {
        series_name: 'The Office (US)',
        is_followed: '1',
        ep_watch_count: '120',
      });
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
      expect(
        normalizeRow('tvtime_tracking', {
          type: 'count-watch-episode-series',
          series_name: 'X',
          watch_count: '5',
        }),
      ).toHaveLength(0);
    });

    it('treats <nil> season/episode as missing (no bogus S0E0 item)', () => {
      // Regression: <nil> previously parsed to 0, creating fake watched-episode items.
      const items = normalizeRow('tvtime_tracking', {
        series_name: 'X',
        season_number: '<nil>',
        episode_number: '<nil>',
      });
      expect(items).toHaveLength(0);
    });

    it('tolerates reordered + extra columns (header-based mapping)', () => {
      const items = normalizeRow('generic_episode', {
        unrelated_extra_col: 'zzz',
        episode_number: '2',
        show_name: 'The Show',
        season_number: '1',
      });
      expect(items).toHaveLength(1);
      expect(items[0].season).toBe(1);
      expect(items[0].episode).toBe(2);
    });
  });

  describe('parseDate', () => {
    it('handles epoch seconds, ms, datetime, 0001 sentinel and <nil>', () => {
      expect(parseDate('1616481927')?.getTime()).toBe(1616481927000);
      expect(parseDate('1616481927000')?.getTime()).toBe(1616481927000);
      expect(parseDate('2021-03-23 04:45:27')?.getFullYear()).toBe(2021);
      expect(parseDate('0001-01-01 00:00:00')).toBeNull();
      expect(parseDate('')).toBeNull();
      expect(parseDate('<nil>')).toBeNull();
    });
  });

  describe('raw TVDB identity extraction', () => {
    it('extracts s_id + episode_id from tracking-prod-records-v2 rows', () => {
      const items = normalizeRow('tvtime_tracking', {
        type: 'watch',
        series_name: 'Show',
        season_number: '1',
        episode_number: '3',
        s_id: '77023',
        episode_id: '654321',
      });
      expect(items[0].rawTvdbSeriesId).toBe('77023');
      expect(items[0].rawTvdbEpisodeId).toBe('654321');
    });

    it('extracts tv_show_id from followed_tv_show / show_seen_episode_latest rows', () => {
      const items = normalizeRow('tvtime_followed', {
        tv_show_name: 'Show',
        tv_show_id: '99',
        is_followed: '1',
      });
      expect(items[0].rawTvdbSeriesId).toBe('99');
    });

    it('treats empty and <nil> IDs as null (never as zero)', () => {
      const a = normalizeRow('tvtime_tracking', {
        series_name: 'Show',
        season_number: '1',
        episode_number: '1',
        s_id: '<nil>',
        episode_id: '',
      });
      expect(a[0].rawTvdbSeriesId).toBeNull();
      expect(a[0].rawTvdbEpisodeId).toBeNull();
    });

    it('canonicalizes spreadsheet-formatted TVDB series and episode IDs', () => {
      const watched = normalizeRow('tvtime_tracking', {
        series_name: 'Nova',
        season_number: '1',
        episode_number: '1',
        s_id: '451834.0',
        episode_id: '6.54321e5',
      });
      expect(watched[0].rawTvdbSeriesId).toBe('451834');
      expect(watched[0].rawTvdbEpisodeId).toBe('654321');

      const followed = normalizeRow('tvtime_followed', {
        tv_show_name: 'Spartacus: House of Ashur',
        tv_show_id: '00442083.000',
        is_followed: '1',
      });
      expect(followed[0].rawTvdbSeriesId).toBe('442083');
    });

    it('drops no-ID sentinels but leaves fractional and unsafe values guarded', () => {
      expect(normalizeNumericExternalId('-1.0')).toBeNull();
      expect(normalizeNumericExternalId('0.0')).toBeNull();
      expect(normalizeNumericExternalId('451834.5')).toBe('451834.5');
      expect(normalizeNumericExternalId('1e30')).toBe('1e30');
    });

    it('extracts absolute episode number when present', () => {
      const items = normalizeRow('tvtime_tracking', {
        series_name: 'Show',
        season_number: '0',
        episode_number: '1',
        absolute_number: '42',
      });
      expect(items[0].absoluteEpisode).toBe(42);
    });

    it('preserves TV Time unitary evidence without treating it as a media type', () => {
      const unitary = normalizeRow('tvtime_tracking', {
        type: 'watch',
        series_name: 'Harry Potter',
        season_number: '1',
        episode_number: '1',
        is_unitary: 'true',
      });
      const regular = normalizeRow('tvtime_tracking', {
        type: 'watch',
        series_name: 'Regular Show',
        season_number: '1',
        episode_number: '1',
        is_unitary: 'false',
      });

      expect(unitary[0].isUnitary).toBe(true);
      expect(unitary[0].entityType).toBe('WATCHED_EPISODE');
      expect(regular[0].isUnitary).toBe(false);
    });
  });
});
