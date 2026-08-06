import {
  ArchiveIdentityIndex,
  archiveShowIdentity,
  archiveShowPartitionKey,
  canonicalMovieTitleFromRangeKey,
} from './archive-identity';

describe('archive show identity', () => {
  it('canonicalizes a TV Time title with an embedded release year', () => {
    expect(archiveShowIdentity('The Flash (2014)')).toEqual({
      title: 'The Flash',
      normTitle: 'the flash',
      rawNormTitle: 'the flash 2014',
      year: 2014,
      key: '["the flash",2014]',
    });
  });

  it('shares an authoritative show match across raw and normalized archive titles', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({ tv_show_name: 'The Flash (2014)', tv_show_id: '279121' });
    index.bindShow('The Flash', 2014, 'media-2014');

    expect(index.seriesIdsFor('The Flash (2014)')).toEqual(['279121']);
    expect(index.resolveShow('The Flash (2014)')).toBe('media-2014');
    expect(index.resolveShow('The Flash', 2014)).toBe('media-2014');
  });

  it('does not conflate remakes when a yearless title is ambiguous', () => {
    const index = new ArchiveIdentityIndex();
    index.bindShow('The Flash', 1990, 'media-1990');
    index.bindShow('The Flash', 2014, 'media-2014');

    expect(index.resolveShow('The Flash (1990)')).toBe('media-1990');
    expect(index.resolveShow('The Flash (2014)')).toBe('media-2014');
    expect(index.resolveShow('The Flash')).toBeNull();
  });

  it('partitions yearless same-title remakes by their exact episode owners', () => {
    expect(archiveShowPartitionKey('One Piece', null, '81797', 'anime-media')).toBe(
      'media:anime-media',
    );
    expect(archiveShowPartitionKey('ONE PIECE', null, null, 'live-action-media')).toBe(
      'media:live-action-media',
    );
    expect(archiveShowPartitionKey('ONE PIECE', 2023, '392276', 'live-action-media')).toBe(
      'media:live-action-media',
    );
  });

  it('uses the TVDB series id before falling back to an ambiguous title/year key', () => {
    expect(archiveShowPartitionKey('Avatar: The Last Airbender', null, '74852')).toBe('tvdb:74852');
    expect(archiveShowPartitionKey('Avatar: The Last Airbender', null, '385925')).toBe(
      'tvdb:385925',
    );
  });

  it('reuses a resolved TVDB episode across files and enforces its parent show', () => {
    const index = new ArchiveIdentityIndex();
    index.bindEpisode('6888431', 'media-2014', 'episode-s05e10');

    expect(index.resolveEpisode(6888431, 'media-2014')).toEqual({
      mediaId: 'media-2014',
      episodeId: 'episode-s05e10',
    });
    expect(index.resolveEpisode(6888431, 'different-show')).toBeNull();
  });

  it('marks conflicting archive episode resolutions as ambiguous', () => {
    const index = new ArchiveIdentityIndex();
    index.bindEpisode('6888431', 'media-2014', 'episode-a');
    index.bindEpisode('6888431', 'media-2014', 'episode-b');

    expect(index.resolveEpisode('6888431')).toBeNull();
  });

  it('reuses a positive episode coordinate found elsewhere in the archive', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({
      series_name: 'The Woods',
      series_id: '380612',
      episode_id: '7781404',
      season_number: '1',
      episode_number: '2',
    });

    expect(index.resolveEpisodeCoordinate('7781404')).toEqual({
      showTitle: 'The Woods',
      seriesId: '380612',
      season: 1,
      episode: 2,
    });
  });

  it('refuses conflicting coordinates for the same episode identity', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({
      series_name: 'Show',
      episode_id: '123',
      season_number: '1',
      episode_number: '2',
    });
    index.addRawRowEvidence({
      series_name: 'Show',
      episode_id: '123',
      season_number: '1',
      episode_number: '3',
    });

    expect(index.resolveEpisodeCoordinate('123')).toBeNull();
  });

  it('shares one provider recovery attempt across concurrent archive rows', async () => {
    const index = new ArchiveIdentityIndex();
    const recover = jest.fn(async () => 'episode-2');

    await expect(
      Promise.all([
        index.recoverEpisodeOnce('7781404', 'the-woods', recover),
        index.recoverEpisodeOnce('7781404', 'the-woods', recover),
      ]),
    ).resolves.toEqual(['episode-2', 'episode-2']);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(index.resolveEpisode('7781404', 'the-woods')).toEqual({
      mediaId: 'the-woods',
      episodeId: 'episode-2',
    });
  });

  it('shares an anthology episode target across watched rows and extras', async () => {
    const index = new ArchiveIdentityIndex();
    const recover = jest.fn(async () => ({
      mediaId: 'bly-manor',
      episodeId: 'bly-manor-s01e01',
    }));

    await expect(
      Promise.all([
        index.recoverEpisodeTargetOnce('7697199', recover),
        index.recoverEpisodeTargetOnce('7697199', recover),
      ]),
    ).resolves.toEqual([
      { mediaId: 'bly-manor', episodeId: 'bly-manor-s01e01' },
      { mediaId: 'bly-manor', episodeId: 'bly-manor-s01e01' },
    ]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(index.resolveEpisode('7697199')).toEqual({
      mediaId: 'bly-manor',
      episodeId: 'bly-manor-s01e01',
    });
  });

  it('recovers an obsolete alias from a bounded archive sequence hole', () => {
    const index = new ArchiveIdentityIndex();
    for (const [episodeId, episodeNumber] of [
      ['7499650', '3'],
      ['7499652', '0'],
      ['7499654', '5'],
      ['7576039', '4'],
    ]) {
      index.addRawRowEvidence({
        series_name: 'Manifest',
        s_id: '361588',
        episode_id: episodeId,
        season_number: '2',
        episode_number: episodeNumber,
      });
    }

    expect(index.inferEpisodeCoordinatesFromArchiveSequence()).toBe(1);
    expect(index.resolveEpisodeCoordinate('7499652')).toEqual({
      showTitle: 'Manifest',
      seriesId: '361588',
      season: 2,
      episode: 4,
    });
  });

  it('recovers an immediately adjacent obsolete alias only when that episode exists elsewhere', () => {
    const index = new ArchiveIdentityIndex();
    for (const [episodeId, episodeNumber] of [
      ['6742808', '0'],
      ['6742809', '5'],
      ['6914549', '4'],
    ]) {
      index.addRawRowEvidence({
        series_name: 'The Good Place',
        episode_id: episodeId,
        season_number: '3',
        episode_number: episodeNumber,
      });
    }

    expect(index.inferEpisodeCoordinatesFromArchiveSequence()).toBe(1);
    expect(index.resolveEpisodeCoordinate('6742808')).toMatchObject({ season: 3, episode: 4 });
  });

  it('does not infer an adjacent id when the candidate episode has no positive archive evidence', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({
      series_name: 'Unknown Show',
      episode_id: '100',
      season_number: '1',
      episode_number: '0',
    });
    index.addRawRowEvidence({
      series_name: 'Unknown Show',
      episode_id: '101',
      season_number: '1',
      episode_number: '2',
    });

    expect(index.inferEpisodeCoordinatesFromArchiveSequence()).toBe(0);
    expect(index.resolveEpisodeCoordinate('100')).toBeNull();
  });

  it('recovers a complete replacement-id season from a complete positive archive season', () => {
    const index = new ArchiveIdentityIndex();
    for (const episodeId of ['9034769', '9054819', '9054820']) {
      index.addRawRowEvidence({
        series_name: 'Russian Doll',
        s_id: '356640',
        episode_id: episodeId,
        season_number: '2',
        episode_number: '0',
      });
    }
    for (const [episodeId, episodeNumber] of [
      ['9120874', '1'],
      ['9120875', '2'],
      ['9120876', '3'],
    ]) {
      index.addRawRowEvidence({
        series_name: 'Russian Doll',
        s_id: '356640',
        episode_id: episodeId,
        season_number: '2',
        episode_number: episodeNumber,
      });
    }

    expect(index.inferEpisodeCoordinatesFromArchiveSequence()).toBe(3);
    expect(
      ['9034769', '9054819', '9054820'].map(
        (episodeId) => index.resolveEpisodeCoordinate(episodeId)?.episode,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('joins a movie tracking row to its comment entity_uuid and carries release-year evidence', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Projām',
      uuid: '0cb60719-67c7-47bf-866e-b14f28fc0d76',
      release_date: '2020-09-23 00:00:00',
    });
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Projām',
      uuid: 'comment-uuid-must-not-win',
      entity_uuid: '0cb60719-67c7-47bf-866e-b14f28fc0d76',
    });

    expect(
      index.identifyMovie('Projām', null, '0cb60719-67c7-47bf-866e-b14f28fc0d76'),
    ).toMatchObject({
      title: 'Projām',
      normTitle: 'projam',
      year: 2020,
      uuid: '0cb60719-67c7-47bf-866e-b14f28fc0d76',
      key: 'uuid:0cb60719-67c7-47bf-866e-b14f28fc0d76',
    });

    index.bindMovie('Projām', null, '0cb60719-67c7-47bf-866e-b14f28fc0d76', 'movie-away');
    expect(index.resolveMovie('Projām', null, '0cb60719-67c7-47bf-866e-b14f28fc0d76')).toBe(
      'movie-away',
    );
    // A secondary row that lost the UUID can still reuse it when the title maps to one UUID.
    expect(index.resolveMovie('Projām')).toBe('movie-away');
  });

  it('shares a provider-verified show-to-movie reclassification across archive files', () => {
    const index = new ArchiveIdentityIndex();
    index.addShowEvidence('Tales of Zestiria: Doushi no Yoake', 2014, '302177');
    index.bindShowAsMovie('Tales of Zestiria: Doushi no Yoake', 2014, ['302177'], 'movie-zestiria');

    expect(index.resolveShowAsMovie('Tales of Zestiria: Doushi no Yoake', 2014)).toBe(
      'movie-zestiria',
    );
    // Secondary rating/comment files commonly omit the year and series id.
    expect(index.resolveShowAsMovie('Tales of Zestiria: Doushi no Yoake')).toBe('movie-zestiria');
    expect(index.resolveMovie('Tales of Zestiria: Doushi no Yoake')).toBe('movie-zestiria');
  });

  it('extracts the final TV Time alpha title from nested tracking range keys', () => {
    expect(canonicalMovieTitleFromRangeKey('rewatch_count-alpha-watch-alpha-wish-dragon')).toBe(
      'wish dragon',
    );
    expect(canonicalMovieTitleFromRangeKey('watch-alpha-mortal')).toBe('mortal');
    expect(canonicalMovieTitleFromRangeKey('watch-123')).toBeNull();
    expect(canonicalMovieTitleFromRangeKey('watch-alpha-65')).toBe('65');
    expect(canonicalMovieTitleFromRangeKey('watch-alpha-alpha-dog')).toBe('alpha dog');
  });

  it('prefers the UUID-linked alpha title while retaining the localized movie title', () => {
    const index = new ArchiveIdentityIndex();
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Torden',
      uuid: 'fae933de-4530-4132-998d-7a3ecdd55418',
      release_date: '2020-09-02 00:00:00',
      alpha_range_key: 'watch-alpha-mortal',
    });

    expect(
      index.identifyMovie('Torden', null, 'fae933de-4530-4132-998d-7a3ecdd55418'),
    ).toMatchObject({
      title: 'mortal',
      normTitle: 'mortal',
      year: 2020,
      hasCanonicalRangeTitle: true,
      titleCandidates: [
        { title: 'mortal', normTitle: 'mortal' },
        { title: 'Torden', normTitle: 'torden' },
      ],
    });
  });

  it('keeps multiple canonical title spellings linked by the same movie UUID', () => {
    const index = new ArchiveIdentityIndex();
    const uuid = 'fdf87c29-6db4-4d3d-aae4-68b5966059fb';
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Fantastic',
      uuid,
      release_date: '2025-07-23 00:00:00',
      alpha_range_key: 'watch-alpha-the-fantastic-4-first-steps',
    });
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Fantastic',
      uuid,
      release_date: '2025-07-23 00:00:00',
      alpha_range_key: 'rewatch_count-alpha-watch-alpha-the-fantastic-four-first-steps',
    });

    expect(index.identifyMovie('Fantastic', null, uuid).titleCandidates).toEqual([
      { title: 'the fantastic 4 first steps', normTitle: 'the fantastic 4 first steps' },
      { title: 'the fantastic four first steps', normTitle: 'the fantastic four first steps' },
      { title: 'Fantastic', normTitle: 'fantastic' },
    ]);
  });

  it('does not trust an alpha title without valid release-date evidence', () => {
    const index = new ArchiveIdentityIndex();
    const uuid = 'fae933de-4530-4132-998d-7a3ecdd55418';
    index.addRawRowEvidence({
      entity_type: 'movie',
      movie_name: 'Torden',
      uuid,
      release_date: '0001-01-01 00:00:00',
      alpha_range_key: 'watch-alpha-mortal',
    });

    expect(index.identifyMovie('Torden', null, uuid)).toMatchObject({
      title: 'Torden',
      normTitle: 'torden',
      year: null,
      hasCanonicalRangeTitle: false,
    });
  });
});
