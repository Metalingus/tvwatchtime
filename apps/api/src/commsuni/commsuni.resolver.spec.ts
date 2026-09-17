import {
  CommsUniResolver,
  UnmappedConversation,
  conversationFingerprint,
} from './commsuni.resolver';
import { CommsUniError } from './commsuni.client';

const entityId = '11111111-1111-4111-8111-111111111111';
const external = (provider: string, providerEntityKind: string, value: string) => ({
  provider,
  providerEntityKind,
  value,
});

function setup(type: 'SHOW' | 'MOVIE' | 'EPISODE' = 'SHOW') {
  const media: any = {
    id: 'media',
    type: type === 'MOVIE' ? 'MOVIE' : 'SHOW',
    title: 'Correct title',
    externalIds: [external('THE_TVDB', type === 'MOVIE' ? 'MOVIE' : 'SERIES', '123')],
    show: { structureProvider: 'TVDB', structureRuleVersion: 1 },
  };
  const episode: any = {
    id: 'episode',
    title: 'Correct episode',
    number: 5,
    updatedAt: new Date('2026-01-01'),
    structureState: 'ACTIVE',
    externalIds: [external('THE_TVDB', 'EPISODE', '555')],
    season: { number: 2, show: { mediaId: 'media' } },
  };
  const prisma: any = {
    mediaCanonicalLink: { findUnique: jest.fn().mockResolvedValue(null) },
    mediaCanonicalCopy: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: { findUnique: jest.fn().mockImplementation(async () => media) },
    episode: { findUnique: jest.fn().mockImplementation(async () => episode) },
    commsUniBinding: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const client: any = {
    enabled: true,
    scope: 'test',
    read: jest.fn().mockImplementation(async () =>
      type === 'EPISODE'
        ? {
            entityType: 'episode',
            entityId,
            showTvdbId: '123',
            tvdbId: '555',
            season: 2,
            episode: 5,
          }
        : { entityType: type.toLowerCase(), entityId, tvdbId: '123' },
    ),
  };
  const canonical: any = {
    resolveMediaId: jest.fn(async (id) => id),
    resolveEpisodeId: jest.fn(async (id) => id),
  };
  const remap: any = {
    resolveTvdbEpisodeAliasesToCanonical: jest
      .fn()
      .mockResolvedValue({ mappings: new Map([['555', 'episode']]), safeManyToOne: false }),
  };
  const tmdb: any = { getShowRoutingProfile: jest.fn().mockResolvedValue({ tvdbId: 123 }) };
  const tvdb: any = {
    getMovieIdentity: jest.fn().mockResolvedValue({ tvdbId: 123, tmdbId: 10, imdbId: null }),
    getEpisodeRoutingIndex: jest
      .fn()
      .mockResolvedValue(new Map([[555, { seasonNumber: 2, episodeNumber: 5 }]])),
  };
  const movieIdentity: any = { resolveTvdbId: jest.fn().mockResolvedValue(null) };
  return {
    service: new CommsUniResolver(prisma, client, canonical, remap, tmdb, tvdb, movieIdentity),
    movieIdentity,
    prisma,
    client,
    media,
    episode,
    tvdb,
    tmdb,
    remap,
    canonical,
  };
}

describe('CommsUni identity resolver', () => {
  it('never interprets a TVDB SERIES alias as a movie alias', async () => {
    const { service, media, client } = setup('MOVIE');
    media.externalIds[0].providerEntityKind = 'SERIES';
    await expect(service.resolve('user', 'MOVIE', 'media')).rejects.toBeInstanceOf(
      UnmappedConversation,
    );
    expect(client.read).not.toHaveBeenCalled();
  });

  it('blocks ambiguous series IDs instead of choosing the first', async () => {
    const { service, media, client } = setup();
    media.externalIds.push(external('THE_TVDB', 'SERIES', '456'));
    await expect(service.resolve('user', 'SHOW', 'media')).rejects.toMatchObject({
      reason: 'missing_or_conflicting_media_ids',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('rejects a poisoned TMDB-to-TVDB series bridge', async () => {
    const { service, media, tmdb, client } = setup();
    media.externalIds.push(external('TMDB', 'SERIES', '10'));
    tmdb.getShowRoutingProfile.mockResolvedValue({ tvdbId: 999 });
    await expect(service.resolve('user', 'SHOW', 'media')).rejects.toMatchObject({
      reason: 'show_tvdb_conflict',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('uses verified TVDB official coordinates, never local TMDB numbering', async () => {
    const { service, media, episode, client } = setup('EPISODE');
    media.show.structureProvider = 'TMDB';
    media.externalIds.push(external('TMDB', 'SERIES', '10'));
    episode.season.number = 1;
    episode.number = 8;
    const target = await service.resolve('user', 'EPISODE', 'episode');
    expect(target.reference).toBe('tvdb-123-s2e5');
    expect(client.read).toHaveBeenCalledWith(
      'user',
      '/entities/episode',
      { tvdbShowId: '123', season: 2, episode: 5 },
      0,
    );
  });

  it('does not pick one part of a combined broadcast', async () => {
    const { service, episode, client } = setup('EPISODE');
    episode.externalIds.push(external('THE_TVDB', 'EPISODE', '556'));
    await expect(service.resolve('user', 'EPISODE', 'episode')).rejects.toMatchObject({
      reason: 'ambiguous_episode_identity',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('detects a combined broadcast even when only its first alias was stored locally', async () => {
    const { service, media, tvdb, remap, client } = setup('EPISODE');
    media.show.structureProvider = 'TMDB';
    media.externalIds.push(external('TMDB', 'SERIES', '10'));
    tvdb.getEpisodeRoutingIndex.mockResolvedValue(
      new Map([
        [555, { seasonNumber: 2, episodeNumber: 5 }],
        [556, { seasonNumber: 2, episodeNumber: 6 }],
      ]),
    );
    remap.resolveTvdbEpisodeAliasesToCanonical.mockImplementation(
      async (_id: string, values: string[]) => ({
        mappings: new Map(values.map((value) => [value, 'episode'])),
        safeManyToOne: values.length > 1,
      }),
    );
    await expect(service.resolve('user', 'EPISODE', 'episode')).rejects.toMatchObject({
      reason: 'episode_bridge_unproven',
    });
    expect(remap.resolveTvdbEpisodeAliasesToCanonical).toHaveBeenCalledWith('media', [
      '555',
      '556',
    ]);
    expect(client.read).not.toHaveBeenCalled();
  });

  it('requires an exact special-episode alias and official membership', async () => {
    const { service, episode, tvdb, client } = setup('EPISODE');
    episode.season.number = 0;
    tvdb.getEpisodeRoutingIndex.mockResolvedValue(new Map());
    await expect(service.resolve('user', 'EPISODE', 'episode')).rejects.toMatchObject({
      reason: 'episode_not_in_official_show',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('rejects an archive response whose episode identity disagrees', async () => {
    const { service, client, prisma } = setup('EPISODE');
    client.read.mockResolvedValue({
      entityType: 'episode',
      entityId,
      showTvdbId: '123',
      tvdbId: '999',
      season: 2,
      episode: 5,
    });
    await expect(service.resolve('user', 'EPISODE', 'episode')).rejects.toMatchObject({
      reason: 'archive_episode_mismatch',
    });
    expect(prisma.commsUniBinding.upsert).not.toHaveBeenCalled();
  });

  it('retains a verified but unarchived target without creating an upstream entity', async () => {
    const { service, client, prisma } = setup();
    client.read.mockRejectedValue(new CommsUniError(404, 'not_found'));
    expect((await service.resolve('user', 'SHOW', 'media')).entityId).toBeNull();
    expect(prisma.commsUniBinding.upsert).toHaveBeenCalled();
  });

  it('rejects cycles even if the legacy canonical helper would return the starting ID', async () => {
    const { service, prisma, client } = setup();
    prisma.mediaCanonicalLink.findUnique.mockImplementation(async ({ where }: any) => ({
      status: 'ACTIVE',
      targetMediaId: where.sourceMediaId === 'a' ? 'b' : 'a',
    }));
    await expect(service.resolve('user', 'SHOW', 'a')).rejects.toMatchObject({
      reason: 'canonical_cycle',
    });
    expect(client.read).not.toHaveBeenCalled();
  });
});

it('does not overwrite a first-write acknowledgement with a concurrent negative lookup', async () => {
  const f = setup();
  f.client.read.mockRejectedValue(new CommsUniError(404, 'not_found'));
  f.prisma.commsUniBinding.upsert.mockImplementation(async ({ create }: any) => ({
    ...create,
    id: 'binding',
    entityId,
  }));
  const target = await f.service.resolve('user', 'SHOW', 'media');
  expect(target.entityId).toBe(entityId);
  expect(f.prisma.commsUniBinding.updateMany).not.toHaveBeenCalled();
});

describe('CommsUni missing movie IDs', () => {
  it('uses verified provider identity without attaching or moving a local movie alias', async () => {
    const { service, media, movieIdentity, client, prisma } = setup('MOVIE');
    media.externalIds = [external('TMDB', 'MOVIE', '10')];
    movieIdentity.resolveTvdbId.mockResolvedValue(123);
    await expect(service.resolve('user', 'MOVIE', 'media')).resolves.toMatchObject({
      reference: 'tvdb-123',
    });
    expect(movieIdentity.resolveTvdbId).toHaveBeenCalledWith('media');
    expect(media.externalIds).toEqual([external('TMDB', 'MOVIE', '10')]);
    expect(prisma.mediaItem.findUnique).toHaveBeenCalledTimes(2);
    expect(client.read).toHaveBeenCalled();
  });

  it('keeps a movie without verified provider identity off the provider API', async () => {
    const { service, media, client } = setup('MOVIE');
    media.externalIds = [external('IMDB', 'MOVIE', 'tt123')];
    await expect(service.resolve('user', 'MOVIE', 'media')).rejects.toMatchObject({
      reason: 'missing_or_conflicting_media_ids',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('refuses a canonical target change during enrichment', async () => {
    const { service, media, canonical, client } = setup('MOVIE');
    media.externalIds = [external('IMDB', 'MOVIE', 'tt123')];
    canonical.resolveMediaId.mockResolvedValueOnce('media').mockResolvedValueOnce('new-target');
    await expect(service.resolve('user', 'MOVIE', 'media')).rejects.toMatchObject({
      reason: 'canonical_mapping_changed',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('accepts a shared IMDb bridge only when both TVDB and TMDB corroborate it', async () => {
    const { service, media, tmdb, tvdb, movieIdentity } = setup('MOVIE');
    media.externalIds.push(external('TMDB', 'MOVIE', '10'), external('IMDB', 'MOVIE', 'tt123'));
    tmdb.getImdbIdForMovieStrict = jest.fn().mockResolvedValue('tt123');
    tvdb.getMovieIdentity.mockResolvedValue({ tvdbId: 123, tmdbId: null, imdbId: 'tt123' });
    await expect(service.resolve('user', 'MOVIE', 'media')).resolves.toMatchObject({
      reference: 'tvdb-123',
    });
    expect(tmdb.getImdbIdForMovieStrict).toHaveBeenCalledWith(10);
    expect(movieIdentity.resolveTvdbId).not.toHaveBeenCalled();
  });

  it.each([null, 'tt999'])('refuses missing or contradictory TMDB proof %j', async (imdbId) => {
    const { service, media, tmdb, tvdb, client } = setup('MOVIE');
    media.externalIds.push(external('TMDB', 'MOVIE', '10'), external('IMDB', 'MOVIE', 'tt123'));
    tmdb.getImdbIdForMovieStrict = jest.fn().mockResolvedValue(imdbId);
    tvdb.getMovieIdentity.mockResolvedValue({ tvdbId: 123, tmdbId: null, imdbId: 'tt123' });
    await expect(service.resolve('user', 'MOVIE', 'media')).rejects.toMatchObject({
      reason: 'movie_tmdb_conflict',
    });
    expect(client.read).not.toHaveBeenCalled();
  });

  it('does not use IMDb to override an explicit TVDB/TMDB contradiction', async () => {
    const { service, media, tmdb, tvdb, client } = setup('MOVIE');
    media.externalIds.push(external('TMDB', 'MOVIE', '10'), external('IMDB', 'MOVIE', 'tt123'));
    tmdb.getImdbIdForMovieStrict = jest.fn().mockResolvedValue('tt123');
    tvdb.getMovieIdentity.mockResolvedValue({ tvdbId: 123, tmdbId: 999, imdbId: 'tt123' });
    await expect(service.resolve('user', 'MOVIE', 'media')).rejects.toMatchObject({
      reason: 'movie_tmdb_conflict',
    });
    expect(tmdb.getImdbIdForMovieStrict).not.toHaveBeenCalled();
    expect(client.read).not.toHaveBeenCalled();
  });
});

describe('CommsUni movie provider links independent of catalog ownership', () => {
  it('rejects changed local identity after a remote lookup', async () => {
    const f = setup('MOVIE');
    f.media.externalIds = [external('TMDB', 'MOVIE', '10')];
    f.movieIdentity.resolveTvdbId.mockImplementation(async () => {
      f.media.externalIds = [external('TMDB', 'MOVIE', '999')];
      return 123;
    });
    await expect(f.service.resolve('user', 'MOVIE', 'media')).rejects.toMatchObject({
      reason: 'movie_mapping_changed',
    });
    expect(f.client.read).not.toHaveBeenCalled();
  });

  it('does not reuse a cached binding for a different verified TVDB movie', async () => {
    const f = setup('MOVIE');
    f.media.externalIds = [external('TMDB', 'MOVIE', '10')];
    f.movieIdentity.resolveTvdbId.mockResolvedValue(123);
    const first = await f.service.resolve('user', 'MOVIE', 'media');
    f.prisma.commsUniBinding.findUnique.mockResolvedValue({
      ...first,
      reference: 'tvdb-999',
      verifiedAt: new Date(),
    });
    f.client.read.mockClear();
    await expect(f.service.resolve('user', 'MOVIE', 'media')).resolves.toMatchObject({
      reference: 'tvdb-123',
    });
    expect(f.client.read).toHaveBeenCalled();
  });

  it('supports a TMDB-only local record and a TVDB record exposing only the matching IMDb ID', async () => {
    const f = setup('MOVIE');
    f.media.externalIds = [external('TMDB', 'MOVIE', '10')];
    f.movieIdentity.resolveTvdbId.mockResolvedValue(123);
    f.tvdb.getMovieIdentity.mockResolvedValue({ tvdbId: 123, tmdbId: null, imdbId: 'tt123' });
    f.tmdb.getImdbIdForMovieStrict = jest.fn().mockResolvedValue('tt123');
    await expect(f.service.resolve('user', 'MOVIE', 'media')).resolves.toMatchObject({
      reference: 'tvdb-123',
    });
    expect(f.media.externalIds).toEqual([external('TMDB', 'MOVIE', '10')]);
  });
});

it('never substitutes an old positive binding when a different verified TVDB reference is missing', async () => {
  const f = setup('MOVIE');
  f.media.externalIds = [external('TMDB', 'MOVIE', '10')];
  f.movieIdentity.resolveTvdbId.mockResolvedValue(123);
  const target = await f.service.resolve('user', 'MOVIE', 'media');
  const oldBinding = { id: 'binding', ...target, reference: 'tvdb-999', verifiedAt: new Date() };
  f.prisma.commsUniBinding.findUnique.mockResolvedValue(oldBinding);
  f.prisma.commsUniBinding.upsert.mockResolvedValue(oldBinding);
  f.client.read.mockRejectedValue(new CommsUniError(404, 'not_archived'));
  await expect(f.service.resolve('user', 'MOVIE', 'media')).resolves.toMatchObject({
    reference: 'tvdb-123',
    entityId: null,
  });
  expect(f.prisma.commsUniBinding.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ reference: 'tvdb-123', entityId: null }),
    }),
  );
});

it('resolves a dry-run destination without persisting a binding', async () => {
  const f = setup('MOVIE');
  const target = await f.service.resolve('user', 'MOVIE', 'media', { persist: false });
  expect(target.reference).toBe('tvdb-123');
  expect(f.prisma.commsUniBinding.upsert).not.toHaveBeenCalled();
  expect(f.prisma.commsUniBinding.updateMany).not.toHaveBeenCalled();
});

it('keeps destination identity stable after translated title/artwork refreshes but detects coordinate changes', () => {
  const media: any = {
    externalIds: [external('THE_TVDB', 'SERIES', '123')],
    show: { structureProvider: 'TVDB', structureRuleVersion: 1 },
  };
  const episode: any = {
    externalIds: [external('THE_TVDB', 'EPISODE', '555')],
    season: { number: 2 },
    number: 5,
    updatedAt: new Date('2026-01-01'),
  };
  const before = conversationFingerprint('EPISODE', 'episode', 'media', media, episode);
  episode.updatedAt = new Date('2026-02-01');
  episode.title = 'Localized title';
  episode.stillUrl = 'new artwork';
  media.externalIds.push(external('TRAKT', 'SERIES', 'unrelated-metadata'));
  media.show.structureDecidedAt = new Date('2026-02-01');
  expect(conversationFingerprint('EPISODE', 'episode', 'media', media, episode)).toBe(before);
  episode.number = 6;
  expect(conversationFingerprint('EPISODE', 'episode', 'media', media, episode)).not.toBe(before);
});
