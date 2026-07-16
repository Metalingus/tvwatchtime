import { Logger } from '@nestjs/common';
import {
  resolveArchiveOwner,
  detectCommentFile,
  normalizeComments,
  dedupeComments,
  commentIdentity,
  parseImageField,
} from './comments';

// Helper to capture Nest Logger output and assert comment text never appears in logs.
function captureLogger(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = Logger.prototype.warn;
  Logger.prototype.warn = function (this: any, msg: any) {
    logs.push(typeof msg === 'string' ? msg : JSON.stringify(msg));
    return orig.call(this, msg);
  };
  return { logs, restore: () => void (Logger.prototype.warn = orig) };
}

const OWNER = '6578993';

describe('tvtime comment owner resolution', () => {
  it('resolves owner id from user.csv (id column)', () => {
    const owner = resolveArchiveOwner([{ filename: 'user.csv', rows: [{ id: OWNER }] }]);
    expect(owner).toBe(OWNER);
  });
  it('resolves owner id from user_personal_data.csv', () => {
    const owner = resolveArchiveOwner([{ filename: 'user_personal_data.csv', rows: [{ user_id: '10142511' }] }]);
    expect(owner).toBe('10142511');
  });
  it('ignores user_tv_show_data.csv (must be exact basename)', () => {
    const owner = resolveArchiveOwner([{ filename: 'user_tv_show_data.csv', rows: [{ tv_show_id: '999', user_id: '999' }] }]);
    expect(owner).toBeNull();
  });
  it('returns null when no owner file is present', () => {
    expect(resolveArchiveOwner([{ filename: 'x.csv', rows: [{ id: '1' }] }])).toBeNull();
  });
});

describe('tvtime comment file detection', () => {
  it('classifies comment files', () => {
    expect(detectCommentFile('comments-prod-comments.csv')).toBe('comments_prod');
    expect(detectCommentFile('episode_comment.csv')).toBe('episode_comment');
    expect(detectCommentFile('profile_comment.csv')).toBe('profile_comment');
    expect(detectCommentFile('episode_comment_like.csv')).toBe('activity');
    expect(detectCommentFile('show_comment_like.csv')).toBe('activity');
    expect(detectCommentFile('object_report.csv')).toBe('activity');
    expect(detectCommentFile('comment_translation.csv')).toBe('activity');
    expect(detectCommentFile('episode_comments_last_read_date.csv')).toBe('activity');
    expect(detectCommentFile('unrelated.csv')).toBe('none');
  });
});

describe('tvtime comment normalization (comments-prod v2)', () => {
  it('imports a top-level movie comment authored by the owner', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'Does anyone know where i can watch this documentary?',
          created_at: '2019-11-11 21:43:10',
          user_id: OWNER,
          is_spoiler: 'false',
          type: 'comment',
          entity_type: 'movie',
          comment_uuid: '62aaf681-aaaa-bbbb-cccc-dddd',
          movie_name: 'The Cleaners',
        },
      ],
      OWNER,
    );
    expect(r.topLevelDetected).toBe(1);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].text).toBe('Does anyone know where i can watch this documentary?');
    expect(r.candidates[0].targetType).toBe('movie');
    expect(r.candidates[0].movieTitle).toBe('The Cleaners');
    expect(r.candidates[0].sourceCreatedAt?.getFullYear()).toBe(2019);
  });

  it('imports only the parent when a top-level comment contains embedded replies', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'Top level',
          created_at: '2019-11-11 21:43:10',
          user_id: OWNER,
          is_spoiler: 'false',
          type: 'comment',
          entity_type: 'movie',
          comment_uuid: 'parent-uuid',
          movie_name: 'M',
          replies: '[map[comment_uuid:child type:reply text:inner]]',
        },
      ],
      OWNER,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].text).toBe('Top level');
    expect(r.repliesSkipped).toBe(1); // the embedded reply counted, not imported
  });

  it('skips a like row (type=like)', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ created_at: '2020-01-01 00:00:00', user_id: OWNER, type: 'like', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.candidates).toHaveLength(0);
    expect(r.activityRowsSkipped).toBe(1);
  });

  it('skips a report row (sort_key prefix report-)', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ sort_key: 'report-abc', user_id: OWNER, type: 'report', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a user-read / last_read marker row', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ sort_key: 'user-read-10142511', user_id: OWNER, last_read: '123' }],
      OWNER,
    );
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a comment authored by another user', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'not mine', user_id: '99999', type: 'comment', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.otherUsersSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a row with type=reply', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'a reply', user_id: OWNER, type: 'reply', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.repliesSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips an empty comment', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: '   ', user_id: OWNER, type: 'comment', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.invalid).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a <nil> comment', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: '<nil>', user_id: OWNER, type: 'comment', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.invalid).toBe(1);
  });

  it('skips a comment-like event without actual text (message empty)', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ type: 'comment', user_id: OWNER, comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.invalid).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('preserves unicode and emoji', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: "Can't wait 😍😍 안녕", user_id: OWNER, type: 'comment', comment_uuid: 'x', entity_type: 'movie', movie_name: 'M' }],
      OWNER,
    );
    expect(r.candidates[0].text).toBe("Can't wait 😍😍 안녕");
  });

  it('preserves line breaks', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'line one\nline two', user_id: OWNER, type: 'comment', comment_uuid: 'x', entity_type: 'movie', movie_name: 'M' }],
      OWNER,
    );
    expect(r.candidates[0].text).toBe('line one\nline two');
  });

  it('preserves spoiler state (is_spoiler true and spoiler_count>0)', () => {
    const a = normalizeComments('comments-prod-comments.csv', [{ text: 'x', user_id: OWNER, type: 'comment', is_spoiler: 'true', comment_uuid: 'a', entity_type: 'movie', movie_name: 'M' }], OWNER).candidates[0];
    const b = normalizeComments('comments-prod-comments.csv', [{ text: 'x', user_id: OWNER, type: 'comment', spoiler_count: '2', comment_uuid: 'b', entity_type: 'movie', movie_name: 'M' }], OWNER).candidates[0];
    expect(a.spoiler).toBe(true);
    expect(b.spoiler).toBe(true);
  });

  it('preserves the source timestamp', () => {
    const r = normalizeComments('comments-prod-comments.csv', [{ text: 'x', created_at: '2016-04-15 19:22:02', user_id: OWNER, type: 'comment', comment_uuid: 'a', entity_type: 'movie', movie_name: 'M' }], OWNER);
    expect(r.candidates[0].sourceCreatedAt?.getTime()).toBe(new Date('2016-04-15T19:22:02').getTime());
  });

  it('preserves language when present', () => {
    const r = normalizeComments('comments-prod-comments.csv', [{ text: 'x', lang: 'it', user_id: OWNER, type: 'comment', comment_uuid: 'a', entity_type: 'movie', movie_name: 'M' }], OWNER);
    expect(r.candidates[0].language).toBe('it');
  });
});

describe('tvtime comment normalization (legacy episode_comment.csv)', () => {
  const top = (extra: Record<string, string> = {}) => ({
    updated_at: '2016-04-21 18:59:22',
    tv_show_name: 'Reign (2013)',
    user_id: OWNER,
    episode_id: '5495142',
    created_at: '2016-04-15 19:22:02',
    depth: '0',
    comment_type: 'comment',
    id: '3000213',
    episode_season_number: '3',
    episode_number: '11',
    comment: "Can't wait 😍😍",
    ...extra,
  });

  it('imports a top-level episode comment (depth 0, no parent)', () => {
    const r = normalizeComments('episode_comment.csv', [top()], OWNER);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].targetType).toBe('episode');
    expect(r.candidates[0].showTitle).toBe('Reign (2013)');
    expect(r.candidates[0].externalEpisodeId).toBe(5495142);
  });

  it('skips a comment with parent_comment_id set (reply)', () => {
    const r = normalizeComments('episode_comment.csv', [top({ parent_comment_id: '3301320' })], OWNER);
    expect(r.repliesSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a comment with depth>0 (reply)', () => {
    const r = normalizeComments('episode_comment.csv', [top({ depth: '1', parent_comment_id: '3301320' })], OWNER);
    expect(r.repliesSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('skips a comment authored by another user', () => {
    const r = normalizeComments('episode_comment.csv', [top({ user_id: '12345' })], OWNER);
    expect(r.otherUsersSkipped).toBe(1);
  });

  it('skips an empty comment in the legacy file', () => {
    const r = normalizeComments('episode_comment.csv', [top({ comment: '' })], OWNER);
    expect(r.invalid).toBe(1);
  });
});

describe('tvtime comment normalization (legacy show_comment.csv)', () => {
  const row = (extra: Record<string, string> = {}) => ({
    tv_show_id: '72173',
    comment: 'Watch it three times!',
    created_at: '2019-09-24 18:24:54',
    updated_at: '2021-01-18 05:03:02',
    nb_likes: '1',
    user_id: OWNER,
    unappropriate_count: '0',
    lang: 'en',
    depth: '0',
    extended_comment: 'null',
    valid: '0',
    spoiler_count: '0',
    comment_type: 'comment',
    only_to_fans: '1',
    id: '1298772',
    parent_comment_id: '',
    source: 'mobile',
    featured: '0',
    tv_show_name: 'Arrested Development',
    ...extra,
  });

  it('imports a top-level show-page comment (target = show)', () => {
    const r = normalizeComments('show_comment.csv', [row()], OWNER);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].targetType).toBe('show');
    expect(r.candidates[0].showTitle).toBe('Arrested Development');
    expect(r.candidates[0].externalEpisodeId).toBeNull();
    expect(r.candidates[0].sourceCommentId).toBe('1298772');
  });

  it('skips a show-page reply (depth>0 / parent)', () => {
    const a = normalizeComments('show_comment.csv', [row({ depth: '1', parent_comment_id: '1438037' })], OWNER);
    expect(a.repliesSkipped).toBe(1);
    expect(a.candidates).toHaveLength(0);
  });

  it('classifies show_comment_like.csv as activity (not a comment file)', () => {
    const r = normalizeComments('show_comment_like.csv', [{ user_id: OWNER, show_comment_id: '1' }], OWNER);
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('classifies show_comments_last_read_date.csv as activity', () => {
    const r = normalizeComments('show_comments_last_read_date.csv', [{ user_id: OWNER, tv_show_id: '1' }], OWNER);
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('imports a v2 show-page comment (entity_type=series) from the unified file', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'Great show',
          created_at: '2020-01-01 00:00:00',
          user_id: OWNER,
          is_spoiler: 'false',
          type: 'comment',
          entity_type: 'series',
          comment_uuid: 'show-uuid',
          series_name: 'Firefly Lane',
        },
      ],
      OWNER,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].targetType).toBe('show');
    expect(r.candidates[0].showTitle).toBe('Firefly Lane');
  });
});

describe('tvtime comment images (image column)', () => {
  it('parseImageField extracts a gif url + format', () => {
    const img = parseImageField('map[format:gif height:278 url:https://media.tenor.co/images/abc/tenor.gif uuid:9be84165 width:498]');
    expect(img).toEqual({ url: 'https://media.tenor.co/images/abc/tenor.gif', format: 'gif' });
  });

  it('parseImageField extracts a png url + format (with extra fields)', () => {
    const img = parseImageField(
      'map[comment_uuid:24300c76 created_at:<nil> format:png height:1024 is_meme:false meme_id:<nil> url:https://d12qk6n9ersps4.cloudfront.net/x/y.png uuid:00c43543 width:576]',
    );
    expect(img).toEqual({ url: 'https://d12qk6n9ersps4.cloudfront.net/x/y.png', format: 'png' });
  });

  it('parseImageField returns null for empty / nil / map[]', () => {
    expect(parseImageField('')).toBeNull();
    expect(parseImageField('<nil>')).toBeNull();
    expect(parseImageField('map[]')).toBeNull();
    expect(parseImageField(undefined)).toBeNull();
  });

  it('imports a comment that has text + a png image', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'Poor guy',
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'u1',
          entity_type: 'movie',
          movie_name: 'The Kissing Booth 2',
          image: 'map[format:png height:1024 url:https://example.com/img.png uuid:abc width:576]',
        },
      ],
      OWNER,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].image).toEqual({ url: 'https://example.com/img.png', format: 'png' });
  });

  it('imports an image-only comment (no text) instead of skipping it', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'u2',
          entity_type: 'movie',
          movie_name: 'M',
          image: 'map[format:gif url:https://media.tenor.co/x.gif uuid:g width:200]',
        },
      ],
      OWNER,
    );
    expect(r.invalid).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].image?.format).toBe('gif');
  });

  it('skips a comment with neither text nor image', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ user_id: OWNER, type: 'comment', comment_uuid: 'u3', entity_type: 'movie', movie_name: 'M' }],
      OWNER,
    );
    expect(r.invalid).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('tvtime comment activity files', () => {
  it('counts episode_comment_like rows as activity, no candidates', () => {
    const r = normalizeComments('episode_comment_like.csv', [{ user_id: OWNER, episode_comment_id: '1' }], OWNER);
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
  it('counts object_report rows as activity', () => {
    const r = normalizeComments('object_report.csv', [{ user_id: OWNER, object_type: 'episode-comment' }], OWNER);
    expect(r.activityRowsSkipped).toBe(1);
  });
  it('counts profile_comment rows as out-of-scope activity', () => {
    const r = normalizeComments('profile_comment.csv', [{ user_id: OWNER, comment: 'hi', parent_comment_id: '' }], OWNER);
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('tvtime comment ambiguous reply status', () => {
  it('a comment-like row with an unrecognized type is skipped as invalid (ambiguous)', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'mystery', user_id: OWNER, type: 'who-knows', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.invalid).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('tvtime comment dedup', () => {
  const mk = (uuid: string, text: string, opts: Partial<{ movie: string; created: string; ep: number }> = {}) => ({
    text,
    user_id: OWNER,
    type: 'comment',
    comment_uuid: uuid,
    entity_type: 'movie',
    movie_name: opts.movie ?? 'M',
    created_at: opts.created ?? '2019-01-01 00:00:00',
    episode_id: String(opts.ep ?? 0),
  });

  it('imports a duplicate comment (same source id) across files once', () => {
    const a = normalizeComments('comments-prod-comments.csv', [mk('uuid-1', 'hello')], OWNER).candidates;
    const b = normalizeComments('comments-prod-comments.csv', [mk('uuid-1', 'hello')], OWNER).candidates;
    const { unique, duplicates } = dedupeComments([...a, ...b]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it('keeps two identical comments on different episodes distinct (no source id → fingerprint includes target)', () => {
    const c1 = normalizeComments('episode_comment.csv', [{
      tv_show_name: 'Show A', user_id: OWNER, episode_id: '111', created_at: '2019-01-01 00:00:00',
      depth: '0', comment_type: 'comment', id: '', episode_season_number: '1', episode_number: '1', comment: 'nice',
    }], OWNER).candidates[0];
    const c2 = normalizeComments('episode_comment.csv', [{
      tv_show_name: 'Show B', user_id: OWNER, episode_id: '222', created_at: '2019-01-01 00:00:00',
      depth: '0', comment_type: 'comment', id: '', episode_season_number: '1', episode_number: '1', comment: 'nice',
    }], OWNER).candidates[0];
    expect(commentIdentity(c1)).not.toBe(commentIdentity(c2));
    const { unique } = dedupeComments([c1, c2]);
    expect(unique).toHaveLength(2);
  });

  it('keeps two identical comments created at different times distinct (fingerprint includes time)', () => {
    const c1 = normalizeComments('comments-prod-comments.csv', [mk('', 'same text', { created: '2019-01-01 00:00:00' })], OWNER).candidates[0];
    const c2 = normalizeComments('comments-prod-comments.csv', [mk('', 'same text', { created: '2020-01-01 00:00:00' })], OWNER).candidates[0];
    expect(commentIdentity(c1)).not.toBe(commentIdentity(c2));
  });
});

describe('tvtime comment privacy (logs must not contain text)', () => {
  it('never writes comment text to the captured logger', () => {
    const SECRET = 'super-secret-comment-content-xyz';
    const { logs, restore } = captureLogger();
    try {
      // Run a normalization that produces candidates and would-be warnings; ensure no text leaks.
      normalizeComments('comments-prod-comments.csv', [
        { text: SECRET, user_id: OWNER, type: 'comment', comment_uuid: 'u', entity_type: 'movie', movie_name: 'M' },
        { text: '<nil>', user_id: OWNER, type: 'comment', comment_uuid: 'v' },
      ], OWNER);
    } finally {
      restore();
    }
    // Even though no logging is expected from this pure function, assert the invariant.
    expect(logs.some((l) => l.includes(SECRET))).toBe(false);
  });
});
