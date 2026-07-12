import {
  TVTIME_RATING_MAPPINGS,
  STARS_V2_ORDER,
  parseVoteId,
  mapRatingId,
  detectRatingFile,
  normalizeRatings,
  dedupeRatings,
  ratingFilePriority,
} from './ratings';

describe('tvtime rating mapping', () => {
  it('verified stars_wording_scalev2 ids map to 1..5 stars', () => {
    expect(mapRatingId('stars_wording_scalev2', 1)).toBe(1);
    expect(mapRatingId('stars_wording_scalev2', 27)).toBe(2);
    expect(mapRatingId('stars_wording_scalev2', 28)).toBe(3);
    expect(mapRatingId('stars_wording_scalev2', 29)).toBe(4);
    expect(mapRatingId('stars_wording_scalev2', 3)).toBe(5);
  });

  it('rating can be derived from the recognized order position', () => {
    // order 1,27,28,29,3 → positions 1..5
    STARS_V2_ORDER.forEach((id, i) => {
      expect(mapRatingId('stars_wording_scalev2', id)).toBe(i + 1);
    });
  });

  it('explicit rating_id (via map) takes priority and resolves correctly', () => {
    // explicit id 29 → 4 stars
    expect(mapRatingId('stars_wording_scalev2', 29)).toBe(4);
  });

  it('final vote_key segment is used as fallback id', () => {
    expect(parseVoteId('11537580-10142511-29')).toBe(29);
    expect(parseVoteId('6881086-10142511-20')).toBe(20);
  });

  it('movie UUID vote keys are parsed safely (only the last segment)', () => {
    // UUID with hyphens embedded; last segment is the id
    expect(parseVoteId('5b9f0df1-c726-4703-8b00-f0249682aaf3-10142511-3')).toBe(3);
    expect(parseVoteId('4face43d-8641-426f-a94c-8e1577edd066-6578993-29')).toBe(29);
  });

  it('unknown rating id within the set is unsupported (null)', () => {
    expect(mapRatingId('stars_wording_scalev2', 20)).toBeNull();
  });

  it('unknown rating set is never guessed', () => {
    expect(mapRatingId('some_other_set', 3)).toBeNull();
    expect(mapRatingId('some_other_set', 1)).toBeNull();
    expect(mapRatingId(null, 3)).toBeNull();
  });

  it('mapping table is keyed by set + id (28 means 3 stars only in stars_wording_scalev2)', () => {
    expect((TVTIME_RATING_MAPPINGS as any).stars_wording_scalev2[28]).toBe(3);
    expect((TVTIME_RATING_MAPPINGS as any).something_else).toBeUndefined();
  });
});

describe('tvtime rating file detection', () => {
  it('classifies vote files vs direct show ratings vs none', () => {
    expect(detectRatingFile('ratings-prod-episode_votes.csv')).toBe('vote');
    expect(detectRatingFile('ratings-3-prod-episode_votes.csv')).toBe('vote');
    expect(detectRatingFile('ratings-v2-prod-votes.csv')).toBe('vote');
    expect(detectRatingFile('ratings-live-votes.csv')).toBe('vote');
    expect(detectRatingFile('tv_show_rate.csv')).toBe('direct_show');
    expect(detectRatingFile('unrelated.csv')).toBe('none');
  });

  it('source-file priority: live > v2 > 3 > prod > tv_show_rate', () => {
    expect(ratingFilePriority('ratings-live-votes.csv')).toBeGreaterThan(ratingFilePriority('ratings-v2-prod-votes.csv'));
    expect(ratingFilePriority('ratings-v2-prod-votes.csv')).toBeGreaterThan(ratingFilePriority('ratings-3-prod-episode_votes.csv'));
    expect(ratingFilePriority('ratings-3-prod-episode_votes.csv')).toBeGreaterThan(ratingFilePriority('ratings-prod-episode_votes.csv'));
    expect(ratingFilePriority('ratings-prod-episode_votes.csv')).toBeGreaterThan(ratingFilePriority('tv_show_rate.csv'));
  });
});

describe('tvtime rating normalization', () => {
  it('parses an episode rating row (id 3 → 5 stars)', () => {
    const r = normalizeRatings('ratings-prod-episode_votes.csv', [
      { episode_id: '7066505', series_name: 'The Walking Dead', season_number: '9', episode_number: '15', user_id: '10142511', vote_key: '7066505-10142511-3' },
    ]);
    expect(r.detected).toBe(1);
    expect(r.candidates[0].normalizedRating).toBe(5);
    expect(r.candidates[0].targetType).toBe('episode');
    expect(r.candidates[0].sourceRatingId).toBe(3);
    expect(r.candidates[0].showTitle).toBe('The Walking Dead');
  });

  it('parses a movie rating row with UUID vote key (id 29 → 4 stars)', () => {
    const r = normalizeRatings('ratings-live-votes.csv', [
      { uuid: '4face43d-8641-426f-a94c-8e1577edd066', vote_key: '4face43d-8641-426f-a94c-8e1577edd066-6578993-29', user_id: '6578993', episode_id: '0', movie_name: 'Atonement' },
    ]);
    expect(r.detected).toBe(1);
    expect(r.candidates[0].normalizedRating).toBe(4);
    expect(r.candidates[0].targetType).toBe('movie');
    expect(r.candidates[0].movieTitle).toBe('Atonement');
  });

  it('counts unsupported rating id as unsupported (not invalid)', () => {
    const r = normalizeRatings('ratings-prod-episode_votes.csv', [
      { episode_id: '6881086', series_name: 'How to Get Away with Murder', season_number: '5', episode_number: '8', user_id: '10142511', vote_key: '6881086-10142511-20' },
    ]);
    expect(r.detected).toBe(0);
    expect(r.unsupported).toBe(1);
    expect(r.candidates[0].supported).toBe(false);
    expect(r.candidates[0].normalizedRating).toBeNull();
  });

  it('imports a legacy direct show rating (rating 5)', () => {
    const r = normalizeRatings('tv_show_rate.csv', [
      { user_id: '10142511', tv_show_id: '268156', rating: '5', created_at: '2017-03-12 08:51:53', updated_at: '2017-03-12 08:51:54', tv_show_name: 'Sense8' },
    ]);
    expect(r.detected).toBe(1);
    expect(r.candidates[0].normalizedRating).toBe(5);
    expect(r.candidates[0].targetType).toBe('show');
    expect(r.candidates[0].showTitle).toBe('Sense8');
    expect(r.candidates[0].sourceCreatedAt?.getFullYear()).toBe(2017);
  });

  it('skips an out-of-range direct rating (0 and 6)', () => {
    const r = normalizeRatings('tv_show_rate.csv', [
      { user_id: '1', tv_show_id: '1', rating: '0', tv_show_name: 'Zero' },
      { user_id: '1', tv_show_id: '2', rating: '6', tv_show_name: 'Six' },
    ]);
    expect(r.detected).toBe(0);
    expect(r.unsupported).toBe(2);
    expect(r.candidates.every((c) => !c.supported)).toBe(true);
  });

  it('counts a row with unparseable vote_key as invalid', () => {
    const r = normalizeRatings('ratings-prod-episode_votes.csv', [
      { episode_id: '1', series_name: 'X', season_number: '1', episode_number: '1', user_id: '1', vote_key: 'no-id-here' },
    ]);
    expect(r.invalid).toBe(1);
    expect(r.detected).toBe(0);
  });
});

describe('tvtime rating dedup', () => {
  const epRow = (set: string) => ({
    episode_id: '7066505', series_name: 'The Walking Dead', season_number: '9', episode_number: '15', user_id: '1', vote_key: `7066505-1-${set}`,
  });

  it('deduplicates the same target across files', () => {
    const a = normalizeRatings('ratings-prod-episode_votes.csv', [epRow('3')]).candidates;
    const b = normalizeRatings('ratings-live-votes.csv', [epRow('3')]).candidates;
    const { unique, duplicates } = dedupeRatings([...a, ...b]);
    expect(unique.length).toBe(1);
    expect(duplicates).toBe(1);
  });

  it('selects the higher-priority (live) file when duplicates conflict', () => {
    const prod = normalizeRatings('ratings-prod-episode_votes.csv', [epRow('1')]).candidates; // 1 star
    const live = normalizeRatings('ratings-live-votes.csv', [epRow('3')]).candidates; // 5 stars
    const { unique } = dedupeRatings([...prod, ...live]);
    expect(unique.length).toBe(1);
    expect(unique[0].sourceFile).toBe('ratings-live-votes.csv');
    expect(unique[0].normalizedRating).toBe(5);
  });

  it('keeps distinct episode vs show vs movie targets separate', () => {
    const all = [
      ...normalizeRatings('ratings-prod-episode_votes.csv', [epRow('3')]).candidates,
      ...normalizeRatings('tv_show_rate.csv', [{ user_id: '1', tv_show_id: '1', rating: '4', tv_show_name: 'The Walking Dead' }]).candidates,
      ...normalizeRatings('ratings-live-votes.csv', [{ uuid: 'u', vote_key: 'u-1-3', user_id: '1', episode_id: '0', movie_name: 'The Walking Dead' }]).candidates,
    ];
    const { unique } = dedupeRatings(all);
    // episode, show, movie are three distinct targets despite the same title
    expect(unique.length).toBe(3);
  });
});
