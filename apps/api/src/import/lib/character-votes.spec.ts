import {
  detectCharacterVoteFile,
  normalizeCharacterVotes,
  dedupeCharacterVotes,
} from './character-votes';

describe('detectCharacterVoteFile', () => {
  it('matches the basename across export layouts', () => {
    expect(detectCharacterVoteFile('show_character_episode_vote.csv')).toBe(true);
    expect(detectCharacterVoteFile('archive/show_character_episode_vote.csv')).toBe(true);
    expect(detectCharacterVoteFile('SHOW_CHARACTER_EPISODE_VOTE.CSV')).toBe(true);
  });

  it('rejects unrelated files', () => {
    expect(detectCharacterVoteFile('seen_episode_source.csv')).toBe(false);
    expect(detectCharacterVoteFile('show_comment.csv')).toBe(false);
  });
});

describe('normalizeCharacterVotes', () => {
  it('maps rows header-keyed regardless of column order (gdpr-data layout)', () => {
    const rows = [
      {
        user_id: '10142511',
        show_character_id: '65264240',
        created_at: '2019-06-25 06:16:52',
        updated_at: '2019-06-25 06:16:57',
        fb_action_id: '',
        tv_show_name: 'The Office (US)',
        episode_id: '4564351',
        episode_season_number: '9',
        episode_number: '23',
      },
    ];
    const res = normalizeCharacterVotes('show_character_episode_vote.csv', rows);
    expect(res).toMatchObject({ detected: 1, invalid: 0 });
    expect(res.candidates[0]).toMatchObject({
      showTitle: 'The Office (US)',
      seasonNumber: 9,
      episodeNumber: 23,
      externalEpisodeId: 4564351,
      showCharacterId: 65264240,
      voteKey: 'episode:4564351:char:65264240',
    });
  });

  it('maps the reordered layouts too (gdpr-data2 / rewatch column orders)', () => {
    const rows = [
      {
        fb_action_id: '',
        episode_season_number: '2',
        episode_number: '7',
        tv_show_name: 'Vikings',
        user_id: '6578993',
        episode_id: '4804537',
        show_character_id: '65136660',
        created_at: '2016-04-17 21:31:30',
        updated_at: '<nil>',
      },
    ];
    const res = normalizeCharacterVotes('show_character_episode_vote.csv', rows);
    expect(res.candidates[0]).toMatchObject({
      seasonNumber: 2,
      episodeNumber: 7,
      externalEpisodeId: 4804537,
      showCharacterId: 65136660,
      sourceUpdatedAt: null, // <nil> normalizes to null
    });
  });

  it('skips rows missing the episode id or character id (invalid, never throws)', () => {
    const rows = [
      { episode_id: '', show_character_id: '5', tv_show_name: 'X' },
      { episode_id: '<nil>', show_character_id: '5', tv_show_name: 'Y' },
      { episode_id: '123', tv_show_name: 'Z' },
    ] as any[];
    const res = normalizeCharacterVotes('show_character_episode_vote.csv', rows);
    expect(res).toMatchObject({ detected: 3, invalid: 3 });
    expect(res.candidates).toHaveLength(0);
  });

  it('returns nothing for non-matching filenames', () => {
    const res = normalizeCharacterVotes('other.csv', [
      { episode_id: '1', show_character_id: '2' },
    ] as any[]);
    expect(res).toMatchObject({ detected: 0, invalid: 0 });
  });
});

describe('dedupeCharacterVotes', () => {
  const vote = (over: Record<string, unknown>) => ({
    sourceRow: 1,
    showTitle: 'S',
    seasonNumber: 1,
    episodeNumber: 1,
    externalEpisodeId: 1,
    showCharacterId: 2,
    voteKey: 'episode:1:char:2',
    sourceCreatedAt: new Date('2020-01-01'),
    sourceUpdatedAt: null,
    ...over,
  });

  it('keeps the latest updated_at per (episode, character)', () => {
    const older = vote({ sourceUpdatedAt: new Date('2020-01-01') });
    const newer = vote({ sourceUpdatedAt: new Date('2021-01-01') });
    expect(dedupeCharacterVotes([older, newer])).toEqual([newer]);
    expect(dedupeCharacterVotes([newer, older])).toEqual([newer]);
  });

  it('falls back to created_at when updated_at is missing', () => {
    const older = vote({ sourceUpdatedAt: null, sourceCreatedAt: new Date('2020-01-01') });
    const newer = vote({ sourceUpdatedAt: null, sourceCreatedAt: new Date('2021-01-01') });
    expect(dedupeCharacterVotes([older, newer])).toEqual([newer]);
  });

  it('keeps only the latest character choice for one source episode', () => {
    const a = vote({
      voteKey: 'episode:1:char:2',
      sourceUpdatedAt: new Date('2020-01-01'),
    });
    const b = vote({
      voteKey: 'episode:1:char:3',
      showCharacterId: 3,
      sourceUpdatedAt: new Date('2021-01-01'),
    });
    expect(dedupeCharacterVotes([a, b])).toEqual([b]);
  });

  it('keeps votes for different source episodes', () => {
    const a = vote({ externalEpisodeId: 1, voteKey: 'episode:1:char:2' });
    const b = vote({ externalEpisodeId: 2, voteKey: 'episode:2:char:2' });
    expect(dedupeCharacterVotes([a, b])).toHaveLength(2);
  });
});
