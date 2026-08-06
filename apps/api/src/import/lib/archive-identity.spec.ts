import {
  ArchiveIdentityIndex,
  archiveShowIdentity,
  archiveShowPartitionKey,
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
});
