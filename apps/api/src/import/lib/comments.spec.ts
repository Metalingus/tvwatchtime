import { Logger } from '@nestjs/common';
import {
  resolveArchiveOwner,
  detectCommentFile,
  normalizeComments,
  dedupeComments,
  commentIdentity,
  parseImageField,
  parseEmbeddedReplies,
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
    const owner = resolveArchiveOwner([
      { filename: 'user_personal_data.csv', rows: [{ user_id: '10142511' }] },
    ]);
    expect(owner).toBe('10142511');
  });
  it('falls back to the majority user_id across per-user files (no identity file present)', () => {
    const owner = resolveArchiveOwner([
      { filename: 'user_tv_show_data.csv', rows: [{ tv_show_id: '1', user_id: '999' }] },
    ]);
    expect(owner).toBe('999');
  });
  it('picks the majority id when several appear', () => {
    const owner = resolveArchiveOwner([
      {
        filename: 'followed_tv_show.csv',
        rows: [{ user_id: '62321337' }, { user_id: '62321337' }, { user_id: '42' }],
      },
      { filename: 'ratings-live-votes.csv', rows: [{ user_id: '62321337' }, { user_id: '42' }] },
    ]);
    expect(owner).toBe('62321337');
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
          entity_uuid: '0cb60719-67c7-47bf-866e-b14f28fc0d76',
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
    expect(r.candidates[0].movieUuid).toBe('0cb60719-67c7-47bf-866e-b14f28fc0d76');
    expect(r.candidates[0].sourceCreatedAt?.getFullYear()).toBe(2019);
  });

  it('imports embedded replies of a top-level comment as reply candidates', () => {
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
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].text).toBe('Top level');
    const reply = r.candidates[1];
    expect(reply.isReply).toBe(true);
    expect(reply.parentSourceCommentId).toBe('parent-uuid');
    expect(reply.text).toBe('inner');
    expect(reply.authorIsOwner).toBe(false); // no user_id in blob → deleted-user identity '0'
    expect(reply.sourceAuthorId).toBe('0');
    expect(r.repliesSkipped).toBe(0);
  });

  describe('embedded replies blobs (v2 `replies` column)', () => {
    const parent = {
      parentSourceCommentId: 'parent-uuid',
      parentDepth: 0,
      sourceRow: 1,
      sourceFile: 'comments-prod-comments.csv',
      targetType: 'movie' as const,
      showTitle: null,
      movieTitle: 'Now You See Me 2',
      seasonNumber: null,
      episodeNumber: null,
      externalEpisodeId: null,
    };
    // Real shape from a production export (spaces/emoji in text, scientific-notation ids).
    const REALISTIC =
      '[map[comment_id:<nil> comment_uuid:parent-uuid created_at:1.656705025e+09 entity_type:movie ' +
      'entity_uuid:50c4ba03-8cd6-4748-8c46-5b7a28c1e66f image:<nil> is_spoiler:false lang:en ' +
      'like_count:0 replies:<nil> reply_count:0 report_count:0 spoiler_count:0 ' +
      'text:3rd expected in May 2023 😃 type:reply updated_at:1.656705025e+09 ' +
      'user_id:2.1270298e+07 uuid:46414e8e-d4ba-4d4e-a4f9-37a7c82f7b4d]]';

    it('parses a realistic blob reply: spaces in text, sci-notation ids, epoch floats', () => {
      const r = parseEmbeddedReplies(REALISTIC, parent, OWNER);
      expect(r.unparseable).toBe(0);
      expect(r.replies).toHaveLength(1);
      const reply = r.replies[0];
      expect(reply.text).toBe('3rd expected in May 2023 😃'); // full text, not truncated at the first space
      expect(reply.sourceAuthorId).toBe('21270298'); // 2.1270298e+07 → integer string
      expect(reply.authorIsOwner).toBe(false);
      expect(reply.isReply).toBe(true);
      expect(reply.parentSourceCommentId).toBe('parent-uuid');
      expect(reply.sourceCommentId).toBe('46414e8e-d4ba-4d4e-a4f9-37a7c82f7b4d');
      expect(reply.legacyCommentId).toBeNull(); // comment_id:<nil>
      expect(reply.depth).toBe(1);
      expect(reply.sourceCreatedAt?.getTime()).toBe(1656705025000);
      expect(reply.language).toBe('en');
      expect(reply.spoiler).toBe(false);
      expect(reply.movieTitle).toBe('Now You See Me 2'); // target inherited from the parent row
      expect(reply.targetType).toBe('movie');
    });

    it('attributes owner-authored blob replies to the owner', () => {
      const blob = `[map[text:my own reply type:reply user_id:${OWNER} uuid:r-1]]`;
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0].authorIsOwner).toBe(true);
      expect(r.replies[0].sourceAuthorId).toBe(OWNER);
    });

    it('maps missing and zero user_id to the shared deleted-user identity', () => {
      const blob = '[map[text:a type:reply user_id:0 uuid:r-1] map[text:b type:reply uuid:r-2]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.unparseable).toBe(0);
      expect(r.replies.map((x) => x.sourceAuthorId)).toEqual(['0', '0']);
    });

    it('walks nested replies, chaining depth and parent uuid', () => {
      const blob =
        '[map[text:outer type:reply user_id:111 uuid:r-1 ' +
        'replies:[map[text:inner reply type:reply user_id:222 uuid:r-2 replies:<nil>]]]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.unparseable).toBe(0);
      expect(r.replies).toHaveLength(2);
      expect(r.replies[0].depth).toBe(1);
      expect(r.replies[0].parentSourceCommentId).toBe('parent-uuid');
      expect(r.replies[1].depth).toBe(2);
      expect(r.replies[1].parentSourceCommentId).toBe('r-1');
      expect(r.replies[1].text).toBe('inner reply');
    });

    it('extracts gif attachments from nested image maps', () => {
      const blob =
        '[map[text:look type:reply user_id:111 uuid:r-1 ' +
        'image:map[format:gif height:270 url:https://media.tenor.co/x.gif width:480]]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.replies[0].image).toEqual({ url: 'https://media.tenor.co/x.gif', format: 'gif' });
    });

    it('accepts image-only replies and spoiler flags', () => {
      const blob =
        '[map[text:<nil> type:reply user_id:111 uuid:r-1 is_spoiler:true spoiler_count:7 ' +
        'image:map[format:png url:https://x.co/i.png]]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0].spoiler).toBe(true);
      expect(r.replies[0].spoilerCount).toBe(7);
    });

    it('counts unparseable entries (no text, garbage user_id) without dropping valid ones', () => {
      const blob =
        '[map[text: type:reply user_id:111 uuid:r-1] ' +
        'map[text:ok reply type:reply user_id:222 uuid:r-2] ' +
        'map[text:bad id type:reply user_id:abc!! uuid:r-3]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.replies).toHaveLength(1);
      expect(r.replies[0].sourceCommentId).toBe('r-2');
      expect(r.unparseable).toBe(2);
    });

    it('handles empty and <nil> blobs', () => {
      expect(parseEmbeddedReplies(undefined, parent, OWNER).replies).toHaveLength(0);
      expect(parseEmbeddedReplies('<nil>', parent, OWNER).replies).toHaveLength(0);
      expect(parseEmbeddedReplies('[]', parent, OWNER).replies).toHaveLength(0);
    });

    it("does not split text on a ']' that is not the map end", () => {
      const blob = '[map[text:see [this] now type:reply user_id:111 uuid:r-1]]';
      const r = parseEmbeddedReplies(blob, parent, OWNER);
      expect(r.replies[0].text).toBe('see [this] now');
    });
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

  it('imports a comment authored by another user as a shadow candidate', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'not mine', user_id: '99999', type: 'comment', comment_uuid: 'x' }],
      OWNER,
    );
    expect(r.otherUsersSkipped).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].authorIsOwner).toBe(false);
    expect(r.candidates[0].sourceAuthorId).toBe('99999');
  });

  it('imports a row with type=reply keeping its parent linkage', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [{ text: 'a reply', user_id: OWNER, type: 'reply', comment_uuid: 'x', parent_uuid: 'p-1' }],
      OWNER,
    );
    expect(r.repliesSkipped).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isReply).toBe(true);
    expect(r.candidates[0].parentSourceCommentId).toBe('p-1');
  });

  it('resolves a v2 reply parent from sort_key when parent_uuid is a self-reference', () => {
    // Real v2 exports duplicate a reply as comment+reply rows; the reply row's parent_uuid
    // is the row's OWN uuid — the true parent is embedded in the sort_key.
    const own = '128a512c-9ad8-44bc-b2f3-27ab5387e8bf';
    const realParent = 'd3dc7f9b-9e4d-4b7e-bf7a-784519a1d013';
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'a reply',
          user_id: OWNER,
          type: 'reply',
          comment_uuid: own,
          parent_uuid: own,
          sort_key: `reply-${own}-1715503181-${realParent}`,
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isReply).toBe(true);
    expect(r.candidates[0].parentSourceCommentId).toBe(realParent);
  });

  it('treats a self-referencing parent_uuid as parentless when no sort_key parent exists', () => {
    const own = '128a512c-9ad8-44bc-b2f3-27ab5387e8bf';
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'a reply',
          user_id: OWNER,
          type: 'reply',
          comment_uuid: own,
          parent_uuid: own,
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].parentSourceCommentId).toBeNull();
  });

  it('keeps a genuine parent_uuid that differs from the row id', () => {
    const own = '128a512c-9ad8-44bc-b2f3-27ab5387e8bf';
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'a reply',
          user_id: OWNER,
          type: 'reply',
          comment_uuid: own,
          parent_uuid: 'd3dc7f9b-9e4d-4b7e-bf7a-784519a1d013',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates[0].parentSourceCommentId).toBe('d3dc7f9b-9e4d-4b7e-bf7a-784519a1d013');
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
      [
        {
          text: "Can't wait 😍😍 안녕",
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'x',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates[0].text).toBe("Can't wait 😍😍 안녕");
  });

  it('preserves line breaks', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'line one\nline two',
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'x',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates[0].text).toBe('line one\nline two');
  });

  it('preserves spoiler state (is_spoiler true and spoiler_count>0)', () => {
    const a = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'x',
          user_id: OWNER,
          type: 'comment',
          is_spoiler: 'true',
          comment_uuid: 'a',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    ).candidates[0];
    const b = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'x',
          user_id: OWNER,
          type: 'comment',
          spoiler_count: '2',
          comment_uuid: 'b',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    ).candidates[0];
    const c = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'x',
          user_id: OWNER,
          type: 'comment',
          spoiler_count: '0',
          comment_uuid: 'c',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    ).candidates[0];
    expect(a.spoiler).toBe(true);
    expect(b.spoiler).toBe(true);
    // The legacy tally is carried through so apply can seed Comment.spoilerCount.
    expect(b.spoilerCount).toBe(2);
    expect(c.spoiler).toBe(false);
    expect(c.spoilerCount).toBe(0);
  });

  it('preserves the source timestamp', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'x',
          created_at: '2016-04-15 19:22:02',
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'a',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.candidates[0].sourceCreatedAt?.getTime()).toBe(
      new Date('2016-04-15T19:22:02').getTime(),
    );
  });

  it('preserves language when present', () => {
    const r = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          text: 'x',
          lang: 'it',
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'a',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
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

  it('imports a comment with parent_comment_id set (reply) keeping the parent key', () => {
    const r = normalizeComments(
      'episode_comment.csv',
      [top({ parent_comment_id: '3301320' })],
      OWNER,
    );
    expect(r.repliesSkipped).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isReply).toBe(true);
    expect(r.candidates[0].parentSourceCommentId).toBe('3301320');
  });

  it('imports a comment with depth>0 (reply)', () => {
    const r = normalizeComments(
      'episode_comment.csv',
      [top({ depth: '1', parent_comment_id: '3301320' })],
      OWNER,
    );
    expect(r.repliesSkipped).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].isReply).toBe(true);
    expect(r.candidates[0].depth).toBe(1);
  });

  it('imports a comment authored by another user (shadow candidate)', () => {
    const r = normalizeComments('episode_comment.csv', [top({ user_id: '12345' })], OWNER);
    expect(r.otherUsersSkipped).toBe(0);
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].authorIsOwner).toBe(false);
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

  it('imports a show-page reply (depth>0 / parent) keeping the parent key', () => {
    const a = normalizeComments(
      'show_comment.csv',
      [row({ depth: '1', parent_comment_id: '1438037' })],
      OWNER,
    );
    expect(a.repliesSkipped).toBe(0);
    expect(a.candidates).toHaveLength(1);
    expect(a.candidates[0].isReply).toBe(true);
    expect(a.candidates[0].parentSourceCommentId).toBe('1438037');
  });

  it('classifies show_comment_like.csv as activity (not a comment file)', () => {
    const r = normalizeComments(
      'show_comment_like.csv',
      [{ user_id: OWNER, show_comment_id: '1' }],
      OWNER,
    );
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });

  it('classifies show_comments_last_read_date.csv as activity', () => {
    const r = normalizeComments(
      'show_comments_last_read_date.csv',
      [{ user_id: OWNER, tv_show_id: '1' }],
      OWNER,
    );
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
    const img = parseImageField(
      'map[format:gif height:278 url:https://media.tenor.co/images/abc/tenor.gif uuid:9be84165 width:498]',
    );
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
      [
        {
          user_id: OWNER,
          type: 'comment',
          comment_uuid: 'u3',
          entity_type: 'movie',
          movie_name: 'M',
        },
      ],
      OWNER,
    );
    expect(r.invalid).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
});

describe('tvtime comment activity files', () => {
  it('counts episode_comment_like rows as activity, no candidates', () => {
    const r = normalizeComments(
      'episode_comment_like.csv',
      [{ user_id: OWNER, episode_comment_id: '1' }],
      OWNER,
    );
    expect(r.activityRowsSkipped).toBe(1);
    expect(r.candidates).toHaveLength(0);
  });
  it('counts object_report rows as activity', () => {
    const r = normalizeComments(
      'object_report.csv',
      [{ user_id: OWNER, object_type: 'episode-comment' }],
      OWNER,
    );
    expect(r.activityRowsSkipped).toBe(1);
  });
  it('counts profile_comment rows as out-of-scope activity', () => {
    const r = normalizeComments(
      'profile_comment.csv',
      [{ user_id: OWNER, comment: 'hi', parent_comment_id: '' }],
      OWNER,
    );
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
  const mk = (
    uuid: string,
    text: string,
    opts: Partial<{ movie: string; created: string; ep: number }> = {},
  ) => ({
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
    const a = normalizeComments(
      'comments-prod-comments.csv',
      [mk('uuid-1', 'hello')],
      OWNER,
    ).candidates;
    const b = normalizeComments(
      'comments-prod-comments.csv',
      [mk('uuid-1', 'hello')],
      OWNER,
    ).candidates;
    const { unique, duplicates } = dedupeComments([...a, ...b]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it('keeps two identical comments on different episodes distinct (no source id → fingerprint includes target)', () => {
    const c1 = normalizeComments(
      'episode_comment.csv',
      [
        {
          tv_show_name: 'Show A',
          user_id: OWNER,
          episode_id: '111',
          created_at: '2019-01-01 00:00:00',
          depth: '0',
          comment_type: 'comment',
          id: '',
          episode_season_number: '1',
          episode_number: '1',
          comment: 'nice',
        },
      ],
      OWNER,
    ).candidates[0];
    const c2 = normalizeComments(
      'episode_comment.csv',
      [
        {
          tv_show_name: 'Show B',
          user_id: OWNER,
          episode_id: '222',
          created_at: '2019-01-01 00:00:00',
          depth: '0',
          comment_type: 'comment',
          id: '',
          episode_season_number: '1',
          episode_number: '1',
          comment: 'nice',
        },
      ],
      OWNER,
    ).candidates[0];
    expect(commentIdentity(c1)).not.toBe(commentIdentity(c2));
    const { unique } = dedupeComments([c1, c2]);
    expect(unique).toHaveLength(2);
  });

  it('merges the SAME comment exported in two files with different id spaces (fingerprint)', () => {
    const text = 'As soon as I heard a few episodes ago Pablo wanted to propose';
    const legacy = normalizeComments(
      'episode_comment.csv',
      [
        {
          tv_show_name: 'Some Show',
          user_id: OWNER,
          episode_id: '111',
          created_at: '2022-08-17 20:51:33',
          depth: '0',
          comment_type: 'comment',
          id: '30854292',
          episode_season_number: '1',
          episode_number: '7',
          comment: text,
        },
      ],
      OWNER,
    ).candidates;
    const v2 = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          type: 'comment',
          user_id: OWNER,
          comment_uuid: '913041bd-bd46-4031-bff9-453cefd03002',
          entity_type: 'episode',
          series_name: 'Some Show',
          season_number: '1',
          episode_number: '7',
          episode_id: '111',
          created_at: '2022-08-17 20:51:33',
          text,
        },
      ],
      OWNER,
    ).candidates;
    expect(legacy[0].sourceCommentId).not.toBe(v2[0].sourceCommentId); // different id spaces
    const { unique, duplicates } = dedupeComments([...legacy, ...v2]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it('merges via the canonical comment_id even when the fingerprint parts differ', () => {
    const text = 'As soon as I heard a few episodes ago Pablo wanted to propose';
    const legacy = normalizeComments(
      'episode_comment.csv',
      [
        {
          tv_show_name: 'Alone',
          user_id: OWNER,
          episode_id: '9170371',
          created_at: '2022-08-17 20:51:32',
          depth: '0',
          comment_type: 'comment',
          id: '30854292',
          episode_season_number: '9',
          episode_number: '11',
          comment: text,
        },
      ],
      OWNER,
    ).candidates;
    const v2 = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          type: 'comment',
          user_id: OWNER,
          comment_uuid: '913041bd-bd46-4031-bff9-453cefd03002',
          comment_id: '30854292',
          entity_type: 'episode',
          series_name: '',
          created_at: '2022-08-17 20:51:33',
          text,
        },
      ],
      OWNER,
    ).candidates;
    // Different identity keys, different target context, 1s apart — but comment_id matches.
    const { unique, duplicates } = dedupeComments([...legacy, ...v2]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });

  it('merges the v2 comment UUID/metadata with the legacy row target identity', () => {
    const text = 'The target lives only in the legacy row';
    const legacy = normalizeComments(
      'episode_comment.csv',
      [
        {
          tv_show_name: 'Invasion (2021)',
          user_id: OWNER,
          episode_id: '8481522',
          created_at: '2022-07-06 18:12:50',
          depth: '0',
          comment_type: 'comment',
          id: '30383010',
          episode_season_number: '1',
          episode_number: '5',
          comment: text,
        },
      ],
      OWNER,
    ).candidates[0];
    const v2 = normalizeComments(
      'comments-prod-comments.csv',
      [
        {
          type: 'comment',
          user_id: OWNER,
          comment_uuid: '641ca013-e5a8-4bec-9f8c-fb5ee5862e27',
          comment_id: '30383010',
          entity_type: 'episode',
          entity_uuid: 'cdb913e1-bc18-4605-bea9-506592e17715',
          created_at: '2022-07-06 18:12:51',
          text,
          lang: 'en',
        },
      ],
      OWNER,
    ).candidates[0];

    const { unique, duplicates } = dedupeComments([v2, legacy]);
    expect(duplicates).toBe(1);
    expect(unique).toHaveLength(1);
    expect(unique[0]).toMatchObject({
      sourceCommentId: '641ca013-e5a8-4bec-9f8c-fb5ee5862e27',
      legacyCommentId: '30383010',
      showTitle: 'Invasion (2021)',
      externalEpisodeId: 8481522,
      seasonNumber: 1,
      episodeNumber: 5,
      language: 'en',
    });
  });

  it('merges the same comment whose created time differs by one second across files', () => {
    const text = 'same content, one second apart';
    const c1 = normalizeComments(
      'comments-prod-comments.csv',
      [mk('uuid-a', text, { created: '2022-08-17 20:51:32' })],
      OWNER,
    ).candidates;
    const c2 = normalizeComments(
      'comments-prod-comments.csv',
      [mk('uuid-b', text, { created: '2022-08-17 20:51:33' })],
      OWNER,
    ).candidates;
    const { unique, duplicates } = dedupeComments([...c1, ...c2]);
    expect(unique).toHaveLength(1);
    expect(duplicates).toBe(1);
  });
});

describe('tvtime comment privacy (logs must not contain text)', () => {
  it('never writes comment text to the captured logger', () => {
    const SECRET = 'super-secret-comment-content-xyz';
    const { logs, restore } = captureLogger();
    try {
      // Run a normalization that produces candidates and would-be warnings; ensure no text leaks.
      normalizeComments(
        'comments-prod-comments.csv',
        [
          {
            text: SECRET,
            user_id: OWNER,
            type: 'comment',
            comment_uuid: 'u',
            entity_type: 'movie',
            movie_name: 'M',
          },
          { text: '<nil>', user_id: OWNER, type: 'comment', comment_uuid: 'v' },
        ],
        OWNER,
      );
    } finally {
      restore();
    }
    // Even though no logging is expected from this pure function, assert the invariant.
    expect(logs.some((l) => l.includes(SECRET))).toBe(false);
  });
});
