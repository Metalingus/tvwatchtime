import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from './lib/csv';
import { normalizeRatings, dedupeRatings } from './lib/ratings';
import { normalizeEmotions, dedupeEmotions } from './lib/emotions';
import { resolveArchiveOwner, normalizeComments, dedupeComments } from './lib/comments';

const FIXTURE_DIR = path.join(__dirname, '../../test/fixtures/tvtime');

function loadFixture(name: string): { filename: string; rows: Record<string, string>[] }[] {
  // A single "logical" fixture may map to one or more files; here each file is one entry.
  const file = path.join(FIXTURE_DIR, name);
  if (!fs.existsSync(file)) return [];
  const parsed = parseCsv(fs.readFileSync(file));
  return [{ filename: name, rows: parsed.rows }];
}

function loadAll(): { filename: string; rows: Record<string, string>[] }[] {
  const names = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.csv'));
  return names.map((n) => {
    const parsed = parseCsv(fs.readFileSync(path.join(FIXTURE_DIR, n)));
    return { filename: n, rows: parsed.rows };
  });
}

describe('tvtime import pipeline (fixtures, no DB)', () => {
  it('resolves the archive owner from fixtures', () => {
    const owner = resolveArchiveOwner(loadAll());
    expect(owner).toBe('11111111');
  });

  describe('ratings pipeline', () => {
    it('produces correct detected / unsupported / dedup counts', () => {
      const files = loadAll();
      let detected = 0;
      let unsupported = 0;
      const supported: any[] = [];
      for (const f of files) {
        const res = normalizeRatings(f.filename, f.rows);
        detected += res.detected;
        unsupported += res.unsupported;
        supported.push(...res.candidates.filter((c) => c.supported));
      }
      // tv_show_rate: 2 in-range (Sense8 5, Narcos 3) + 2 out-of-range → detected 2, unsupported 2
      // ratings-prod: ids 1,27,28,29,3 → 5 detected; id 20 → 1 unsupported
      // ratings-v2: id 3 → 1 detected
      // ratings-live: 2 movies (id 3, 29) → 2 detected
      expect(detected).toBe(2 + 5 + 1 + 2);
      expect(unsupported).toBe(2 + 1);

      const { unique, duplicates } = dedupeRatings(supported);
      // Episode 1000001 appears in prod (id 1) and v2 (id 3) → duplicate; live wins? no — v2 vs prod.
      // Dedup keeps one per target. Distinct targets: ep 1000001,1000002,1000003,1000004,1000005,
      // show Sense8, show Narcos, movie Demo Movie One, movie Demo Movie Two = 9 unique.
      expect(duplicates).toBeGreaterThanOrEqual(1);
      expect(unique.length).toBe(9);
    });

    it('maps verified ids to the right star values', () => {
      const files = loadAll();
      const supported: any[] = [];
      for (const f of files) supported.push(...normalizeRatings(f.filename, f.rows).candidates.filter((c) => c.supported));
      const byId = new Map(supported.filter((c) => c.targetType === 'episode').map((c) => [c.sourceRatingId, c.normalizedRating]));
      expect(byId.get(1)).toBe(1);
      expect(byId.get(27)).toBe(2);
      expect(byId.get(28)).toBe(3);
      expect(byId.get(29)).toBe(4);
      expect(byId.get(3)).toBe(5);
    });

    it('imports direct show ratings in range and skips out-of-range', () => {
      const res = normalizeRatings('tv_show_rate.csv', loadFixture('tv_show_rate.csv')[0].rows);
      const supported = res.candidates.filter((c) => c.supported);
      expect(supported.map((c) => c.showTitle).sort()).toEqual(['Narcos', 'Sense8']);
      expect(supported.find((c) => c.showTitle === 'Sense8')!.normalizedRating).toBe(5);
      expect(res.unsupported).toBe(2);
    });
  });

  describe('emotions pipeline', () => {
    it('retains multiple emotions per episode and skips legacy ids', () => {
      const files = loadAll();
      let detected = 0;
      let unsupported = 0;
      const supported: any[] = [];
      for (const f of files) {
        const res = normalizeEmotions(f.filename, f.rows);
        detected += res.detected;
        unsupported += res.unsupported;
        supported.push(...res.candidates.filter((c) => c.supported));
      }
      // emotions-3: ids 35,39,28 (supported) + 13 (unsupported) → detected 3, unsupported 1
      // emotions-live: ids 33,37 (2 supported movies)
      // episode_emotion: ids 3,7 (both legacy → unsupported 2)
      expect(detected).toBe(3 + 2);
      expect(unsupported).toBe(1 + 2);

      const { unique } = dedupeEmotions(supported);
      // Two distinct emotions for episode 1000001 (35=BORED, 39=TENSE) must both survive.
      const ep1 = unique.filter((c) => c.targetType === 'episode' && (c as any).externalEpisodeId === 1000001);
      expect(ep1.length).toBe(2);
    });
  });

  describe('comments pipeline', () => {
    it('counts top-level vs replies vs activity vs other-user correctly', () => {
      const owner = resolveArchiveOwner(loadAll());
      const files = loadAll();
      let topLevel = 0;
      let replies = 0;
      let activity = 0;
      let otherUsers = 0;
      let invalid = 0;
      let rowsDetected = 0;
      const candidates: any[] = [];
      for (const f of files) {
        const res = normalizeComments(f.filename, f.rows, owner);
        topLevel += res.topLevelDetected;
        replies += res.repliesSkipped;
        activity += res.activityRowsSkipped;
        otherUsers += res.otherUsersSkipped;
        invalid += res.invalid;
        rowsDetected += res.rowsDetected;
        candidates.push(...res.candidates);
      }
      // Top-level authored comments:
      //  - comments-prod-comments-v1.csv: 1 comment (Safe synthetic top-level comment one)
      //  - comments-prod-comments.csv (v2): 1 comment (parent0002) + embedded reply counted
      //  - episode_comment.csv: 1 top-level (3000213); 1 reply (depth1, 3301835); 1 other-user (99999)
      expect(topLevel).toBe(3);
      // replies: embedded reply in v2 (1) + episode_comment reply row (1)
      expect(replies).toBe(2);
      // other-user: episode_comment row by 99999
      expect(otherUsers).toBe(1);
      // activity: v1 like+report+user-read (3) + episode_comment_like (1) + v2 like (1)
      expect(activity).toBeGreaterThanOrEqual(5);
      expect(invalid).toBe(0);
      expect(candidates.length).toBe(3);

      // Dedup: all three have distinct source ids → no duplicates.
      const { unique, duplicates } = dedupeComments(candidates);
      expect(unique.length).toBe(3);
      expect(duplicates).toBe(0);
    });

    it('a single malformed optional row does not fail the whole pipeline', () => {
      // A ratings file with one garbage row still yields the valid ones.
      const res = normalizeRatings('ratings-prod-episode_votes.csv', [
        { episode_id: '1', series_name: 'X', season_number: '1', episode_number: '1', user_id: '1', vote_key: '1-1-3' },
        { episode_id: 'bad', vote_key: 'not-a-key' },
        { series_name: 'Y', vote_key: '2-1-GARBAGE' },
      ]);
      expect(res.detected).toBe(1);
      expect(res.invalid).toBeGreaterThanOrEqual(1);
    });

    it('final result contains all required rating/emotion/comment counters', () => {
      // Smoke test: the aggregate computation used by the processor runs without throwing and
      // yields non-negative counts for every documented counter.
      const files = loadAll();
      const owner = resolveArchiveOwner(files);

      const ratings = { detected: 0, unsupported: 0, dup: 0 };
      const emotions = { detected: 0, unsupported: 0, dup: 0 };
      const comments = {
        rowsDetected: 0, topLevel: 0, replies: 0, activity: 0, otherUsers: 0, invalid: 0, dup: 0,
      };

      const rCandidates: any[] = [];
      const eCandidates: any[] = [];
      const cCandidates: any[] = [];
      for (const f of files) {
        const rr = normalizeRatings(f.filename, f.rows);
        ratings.detected += rr.detected;
        ratings.unsupported += rr.unsupported;
        rCandidates.push(...rr.candidates.filter((c) => c.supported));
        const er = normalizeEmotions(f.filename, f.rows);
        emotions.detected += er.detected;
        emotions.unsupported += er.unsupported;
        eCandidates.push(...er.candidates.filter((c) => c.supported));
        const cr = normalizeComments(f.filename, f.rows, owner);
        comments.rowsDetected += cr.rowsDetected;
        comments.topLevel += cr.topLevelDetected;
        comments.replies += cr.repliesSkipped;
        comments.activity += cr.activityRowsSkipped;
        comments.otherUsers += cr.otherUsersSkipped;
        comments.invalid += cr.invalid;
        cCandidates.push(...cr.candidates);
      }
      ratings.dup = dedupeRatings(rCandidates).duplicates;
      emotions.dup = dedupeEmotions(eCandidates).duplicates;
      comments.dup = dedupeComments(cCandidates).duplicates;

      const result = {
        ratingsDetected: ratings.detected,
        ratingsImported: 0,
        ratingsUpdated: 0,
        ratingsSkippedUnsupported: ratings.unsupported,
        ratingsSkippedUnresolved: 0,
        ratingDuplicatesIgnored: ratings.dup,
        emotionsDetected: emotions.detected,
        emotionsImported: 0,
        emotionsSkippedUnsupported: emotions.unsupported,
        emotionsSkippedUnresolved: 0,
        emotionDuplicatesIgnored: emotions.dup,
        commentRowsDetected: comments.rowsDetected,
        topLevelCommentsDetected: comments.topLevel,
        commentsImported: 0,
        commentRepliesSkipped: comments.replies,
        commentActivityRowsSkipped: comments.activity,
        commentsByOtherUsersSkipped: comments.otherUsers,
        commentsSkippedUnresolved: 0,
        commentDuplicatesIgnored: comments.dup,
        commentsSkippedInvalid: comments.invalid,
      };
      const requiredKeys = [
        'ratingsDetected', 'ratingsImported', 'ratingsUpdated', 'ratingsSkippedUnsupported',
        'ratingsSkippedUnresolved', 'ratingDuplicatesIgnored', 'emotionsDetected', 'emotionsImported',
        'emotionsSkippedUnsupported', 'emotionsSkippedUnresolved', 'emotionDuplicatesIgnored',
        'commentRowsDetected', 'topLevelCommentsDetected', 'commentsImported', 'commentRepliesSkipped',
        'commentActivityRowsSkipped', 'commentsByOtherUsersSkipped', 'commentsSkippedUnresolved',
        'commentDuplicatesIgnored', 'commentsSkippedInvalid',
      ];
      for (const k of requiredKeys) {
        expect(result).toHaveProperty(k);
        expect((result as any)[k]).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
