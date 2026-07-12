import {
  TVTIME_EMOTION_MAPPINGS,
  parseEmotionVoteId,
  mapEmotionId,
  detectEmotionFile,
  normalizeEmotions,
  dedupeEmotions,
} from './emotions';

describe('tvtime emotion mapping', () => {
  it('every 12_all id maps to the correct internal key', () => {
    const expected: Record<number, string> = {
      28: 'SHOCKED', 29: 'FRUSTRATED', 30: 'SAD', 31: 'REFLECTIVE', 32: 'TOUCHED',
      33: 'AMUSED', 34: 'SCARED', 35: 'BORED', 36: 'UNDERSTANDING', 37: 'THRILLED',
      38: 'CONFUSED', 39: 'TENSE',
    };
    for (const [id, key] of Object.entries(expected)) {
      expect(mapEmotionId('12_all', Number(id))).toBe(key);
    }
  });

  it('id 36 maps to UNDERSTANDING (the DB enum), not the label "UNDERSTOOD"', () => {
    expect(mapEmotionId('12_all', 36)).toBe('UNDERSTANDING');
    expect(mapEmotionId('12_all', 36)).not.toBe('UNDERSTOOD');
  });

  it('explicit emotion_id takes priority and resolves', () => {
    expect(mapEmotionId('12_all', 35)).toBe('BORED');
  });

  it('vote-key fallback works', () => {
    expect(parseEmotionVoteId('7495678-10142511-38')).toBe(38);
  });

  it('movie emotion UUID key is parsed safely (last segment only)', () => {
    expect(parseEmotionVoteId('da10ef2f-b343-4563-8382-8e03248b32bf-6578993-37')).toBe(37);
  });

  it('unknown emotion set is skipped', () => {
    expect(mapEmotionId('legacy', 3)).toBeNull();
    expect(mapEmotionId(null, 28)).toBeNull();
  });

  it('unknown legacy id is skipped (not guessed)', () => {
    for (const id of [1, 3, 6, 7, 13, 14, 18, 23, 26]) {
      expect(mapEmotionId('12_all', id)).toBeNull();
    }
  });

  it('mapping table is keyed by set + id', () => {
    expect((TVTIME_EMOTION_MAPPINGS as any)['12_all'][33]).toBe('AMUSED');
    expect((TVTIME_EMOTION_MAPPINGS as any).something_else).toBeUndefined();
  });
});

describe('tvtime emotion file detection', () => {
  it('classifies vote vs legacy explicit vs none', () => {
    expect(detectEmotionFile('emotions-3-prod-episode_votes.csv')).toBe('vote');
    expect(detectEmotionFile('emotions-v2-prod-votes.csv')).toBe('vote');
    expect(detectEmotionFile('emotions-live-votes.csv')).toBe('vote');
    expect(detectEmotionFile('episode_emotion.csv')).toBe('legacy_explicit');
    expect(detectEmotionFile('tv_show_user_emotion_count.csv')).toBe('none');
    expect(detectEmotionFile('unrelated.csv')).toBe('none');
  });
});

describe('tvtime emotion normalization', () => {
  it('parses a 12_all episode emotion (id 35 → BORED)', () => {
    const r = normalizeEmotions('emotions-3-prod-episode_votes.csv', [
      { vote_key: '6997931-10142511-35', episode_id: '6997931', user_id: '10142511', series_name: 'Riverdale', season_number: '3', episode_number: '16' },
    ]);
    expect(r.detected).toBe(1);
    expect(r.candidates[0].normalizedEmotion).toBe('BORED');
  });

  it('parses a movie emotion with UUID key (id 33 → AMUSED)', () => {
    const r = normalizeEmotions('emotions-live-votes.csv', [
      { user_id: '6578993', uuid: '82409a25-6ecc-4ec5-be45-784ad5f660d4', episode_id: '0', movie_name: 'Alien Resurrection', vote_key: '82409a25-6ecc-4ec5-be45-784ad5f660d4-6578993-33' },
    ]);
    expect(r.detected).toBe(1);
    expect(r.candidates[0].normalizedEmotion).toBe('AMUSED');
    expect(r.candidates[0].targetType).toBe('movie');
  });

  it('legacy episode_emotion ids are unsupported', () => {
    const r = normalizeEmotions('episode_emotion.csv', [
      { created_at: '2017-04-11 02:16:57', updated_at: '2017-04-11 02:16:57', tv_show_name: 'The Wire', episode_season_number: '5', episode_number: '10', user_id: '10142511', episode_id: '348314', emotion_id: '3' },
    ]);
    expect(r.detected).toBe(0);
    expect(r.unsupported).toBe(1);
    expect(r.candidates[0].supported).toBe(false);
  });

  it('unknown id within a vote file is unsupported', () => {
    const r = normalizeEmotions('emotions-v2-prod-votes.csv', [
      { vote_key: '6997931-10142511-23', episode_id: '6997931', user_id: '10142511', series_name: 'Riverdale', season_number: '3', episode_number: '16' },
    ]);
    expect(r.unsupported).toBe(1);
    expect(r.candidates[0].supported).toBe(false);
  });
});

describe('tvtime emotion dedup', () => {
  const base = (id: string) => ({ vote_key: `6997931-10142511-${id}`, episode_id: '6997931', user_id: '10142511', series_name: 'Riverdale', season_number: '3', episode_number: '16' });

  it('retains multiple distinct emotions for one episode', () => {
    const all = [
      ...normalizeEmotions('emotions-3-prod-episode_votes.csv', [base('29'), base('35'), base('39')]).candidates,
    ];
    const { unique } = dedupeEmotions(all);
    expect(unique.length).toBe(3);
  });

  it('ignores a duplicate (target, emotion) across files', () => {
    const a = normalizeEmotions('emotions-3-prod-episode_votes.csv', [base('35')]).candidates;
    const b = normalizeEmotions('emotions-v2-prod-votes.csv', [base('35')]).candidates;
    const { unique, duplicates } = dedupeEmotions([...a, ...b]);
    expect(unique.length).toBe(1);
    expect(duplicates).toBe(1);
  });
});
