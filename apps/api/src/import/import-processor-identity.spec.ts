import { ImportProcessor } from './import.processor';
import { ArchiveIdentityIndex } from './lib/archive-identity';

describe('ImportProcessor external episode identity', () => {
  it('reuses a TVDB-partitioned movie-group decision for title-only activity rows', () => {
    const processor = new ImportProcessor({} as any, {} as any, {} as any, {} as any, {} as any);
    const archiveIdentity = new ArchiveIdentityIndex();
    archiveIdentity.addShowEvidence('Harry Potter', null, '351875');
    const harryTwo = {
      mediaId: 'harry-potter-2',
      confidence: 0.95,
      matchedTitle: 'Harry Potter and the Chamber of Secrets',
      tmdbId: 672,
    };
    const groups = new Map([
      [
        'tvdb:351875',
        {
          axis: 'season' as const,
          moviesByCoordinate: new Map([['2:1', harryTwo]]),
        },
      ],
    ]);

    expect(
      (processor as any).movieGroupMatchForExtra(
        { showTitle: 'Harry Potter', seasonNumber: 2, episodeNumber: 1 },
        archiveIdentity,
        groups,
      ),
    ).toEqual(harryTwo);
  });

  it('resolves an extra entity through its exact episode owner instead of a same-title remake', async () => {
    const matcher = {
      matchPrefetchedShowByEpisodeIds: jest.fn(() => ({
        mediaId: 'one-piece-anime',
        confidence: 0.95,
        matchedTitle: 'One Piece',
        conflict: false,
        matchedAliasCount: 1,
      })),
      resolveEpisodeByExternalIds: jest.fn(async () => 'anime-episode'),
      resolveEpisode: jest.fn(async () => null),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
      matchMedia: jest.fn(),
      classify: jest.fn(() => 'matched'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    archiveIdentity.bindShow('One Piece', null, 'one-piece-live-action');

    const result = await (processor as any).resolveShowEpisode(
      'One Piece',
      1,
      1,
      new Map([['one piece', 'one-piece-live-action']]),
      false,
      null,
      '12345',
      archiveIdentity,
    );

    expect(result).toEqual({
      mediaId: 'one-piece-anime',
      episodeId: 'anime-episode',
      confidence: 0.9,
      status: 'MATCHED',
    });
    expect(matcher.resolveEpisodeByExternalIds).toHaveBeenCalledWith('one-piece-anime', {
      tvdb: 12345,
    });
    expect(matcher.matchMedia).not.toHaveBeenCalled();
  });

  it('fills an SxE0 extra from a positive coordinate elsewhere in the same archive', async () => {
    const matcher = {
      matchPrefetchedShowByEpisodeIds: jest.fn(() => ({
        mediaId: null,
        confidence: 0,
        matchedTitle: null,
        conflict: false,
        matchedAliasCount: 0,
      })),
      resolveEpisodeByExternalIds: jest.fn(async () => null),
      resolveEpisode: jest.fn(async (_mediaId: string, season: number, episode: number) =>
        season === 1 && episode === 2 ? 'woods-s01e02' : null,
      ),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
      matchMedia: jest.fn(),
      classify: jest.fn(() => 'matched'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    archiveIdentity.addRawRowEvidence({
      series_name: 'The Woods',
      series_id: '380612',
      episode_id: '7781404',
      season_number: '1',
      episode_number: '2',
    });
    archiveIdentity.bindShow('The Woods', null, 'the-woods');

    const result = await (processor as any).resolveShowEpisode(
      'The Woods',
      1,
      0,
      new Map(),
      false,
      null,
      '7781404',
      archiveIdentity,
    );

    expect(result).toEqual({
      mediaId: 'the-woods',
      episodeId: 'woods-s01e02',
      confidence: 0.9,
      status: 'MATCHED',
    });
    expect(matcher.resolveEpisode).toHaveBeenCalledWith('the-woods', 1, 2);
    expect(matcher.recoverEpisodeByTvdbId).not.toHaveBeenCalled();
  });

  it('keeps an unresolvable SxE0 legacy id out of manual review', async () => {
    const matcher = {
      matchPrefetchedShowByEpisodeIds: jest.fn(() => ({
        mediaId: null,
        confidence: 0,
        matchedTitle: null,
        conflict: false,
        matchedAliasCount: 0,
      })),
      resolveEpisodeByExternalIds: jest.fn(async () => null),
      resolveEpisode: jest.fn(async () => null),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
      matchMedia: jest.fn(),
      classify: jest.fn(() => 'matched'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    archiveIdentity.bindShow('Leah Remini: Scientology and the Aftermath', null, 'leah-remini');

    await expect(
      (processor as any).resolveShowEpisode(
        'Leah Remini: Scientology and the Aftermath',
        3,
        0,
        new Map(),
        false,
        null,
        '6910898',
        archiveIdentity,
      ),
    ).resolves.toEqual({
      mediaId: 'leah-remini',
      episodeId: null,
      confidence: 0,
      status: 'UNMATCHED',
    });
    expect(matcher.recoverEpisodeByTvdbId).toHaveBeenCalledTimes(1);
    expect(matcher.resolveEpisode).not.toHaveBeenCalled();
  });

  it('routes an anthology season to the separate TMDB show identified by its episode id', async () => {
    const matcher = {
      matchPrefetchedShowByEpisodeIds: jest.fn(() => ({
        mediaId: null,
        confidence: 0,
        matchedTitle: null,
        conflict: false,
        matchedAliasCount: 0,
      })),
      resolveEpisodeByExternalIds: jest.fn(async () => null),
      resolveEpisode: jest.fn(async () => null),
      recoverEpisodeTargetByTvdbId: jest.fn(async () => ({
        mediaId: 'bly-manor',
        episodeId: 'bly-manor-s01e01',
      })),
      recoverEpisodeByTvdbId: jest.fn(async () => null),
      matchMedia: jest.fn(),
      classify: jest.fn(() => 'matched'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    archiveIdentity.bindShow('The Haunting', null, 'hill-house');

    await expect(
      (processor as any).resolveShowEpisode(
        'The Haunting',
        2,
        1,
        new Map(),
        false,
        null,
        '7697199',
        archiveIdentity,
      ),
    ).resolves.toEqual({
      mediaId: 'bly-manor',
      episodeId: 'bly-manor-s01e01',
      confidence: 0.9,
      status: 'MATCHED',
    });
    expect(matcher.recoverEpisodeTargetByTvdbId).toHaveBeenCalledWith(
      'The Haunting',
      null,
      '7697199',
    );
    expect(archiveIdentity.resolveEpisode('7697199')).toEqual({
      mediaId: 'bly-manor',
      episodeId: 'bly-manor-s01e01',
    });
    expect(matcher.recoverEpisodeByTvdbId).not.toHaveBeenCalled();
  });

  it('matches movie extras through the UUID-linked canonical alpha title', async () => {
    const matcher = {
      matchMedia: jest.fn(async (_norm: string, title: string, type: string, year: number) =>
        title === 'mortal' && type === 'MOVIE' && year === 2020
          ? { mediaId: 'movie-mortal', confidence: 0.9, matchedTitle: 'Mortal' }
          : { mediaId: null, confidence: 0, matchedTitle: null },
      ),
      classify: jest.fn(() => 'matched'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    const uuid = 'fae933de-4530-4132-998d-7a3ecdd55418';
    archiveIdentity.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Torden',
      uuid,
      release_date: '2020-09-02 00:00:00',
      alpha_range_key: 'follow-alpha-mortal',
    });

    const result = await (processor as any).resolveMovieTarget(
      'Torden',
      uuid,
      null,
      archiveIdentity,
    );

    expect(result).toEqual({
      mediaId: 'movie-mortal',
      episodeId: null,
      confidence: 0.9,
      status: 'MATCHED',
    });
    expect(matcher.matchMedia).toHaveBeenCalledWith(
      'mortal',
      'mortal',
      'MOVIE',
      2020,
      undefined,
      null,
    );
    expect(archiveIdentity.resolveMovie('Torden', null, uuid)).toBe('movie-mortal');
  });

  it('suppresses a low-confidence movie suggestion when canonical archive evidence exists', async () => {
    const matcher = {
      matchMedia: jest.fn(async () => ({
        mediaId: 'wrong-olympics-movie',
        confidence: 0.5,
        matchedTitle: '1992 Olympics',
      })),
      classify: jest.fn(() => 'needs_review'),
    };
    const processor = new ImportProcessor(
      {} as any,
      {} as any,
      {} as any,
      matcher as any,
      {} as any,
    );
    const archiveIdentity = new ArchiveIdentityIndex();
    const uuid = '0f08dc5c-2229-45dc-bf05-b12280deba72';
    archiveIdentity.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: "Cérémonie d'ouverture des Jeux olympiques d'été de Paris 2024",
      uuid,
      release_date: '2024-07-26 00:00:00',
      alpha_range_key: 'towatch-alpha-paris-2024-summer-olympics-opening-ceremony',
    });

    await expect(
      (processor as any).resolveMovieTarget(
        "Cérémonie d'ouverture des Jeux olympiques d'été de Paris 2024",
        uuid,
        null,
        archiveIdentity,
      ),
    ).resolves.toEqual({
      mediaId: null,
      episodeId: null,
      confidence: 0,
      status: 'UNMATCHED',
    });
    expect(archiveIdentity.resolveMovie('', null, uuid)).toBeNull();
  });
});
