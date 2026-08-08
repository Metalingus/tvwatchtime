import { StructureProvider, StructureReason } from '@prisma/client';
import {
  isStrictTmdbAnime,
  STRUCTURE_RULE_VERSION,
  StructureAuthorityService,
} from './structure-authority.service';

describe('isStrictTmdbAnime', () => {
  it.each([
    [[16], ['anime'], true],
    [[16], [], false],
    [[18], ['anime'], false],
    [[18], [], false],
  ])('classifies genres=%j keywords=%j as %s', (genres, keywords, expected) => {
    expect(isStrictTmdbAnime(genres as number[], keywords as string[])).toBe(expected);
  });
});

describe('StructureAuthorityService', () => {
  const prisma = {
    mediaItem: { findUnique: jest.fn() },
    externalId: { findFirst: jest.fn() },
  };
  const tmdb = {
    enabled: true,
    getShowRoutingProfile: jest.fn(),
    findByExternalId: jest.fn(),
    getShow: jest.fn(),
  };
  const tvdb = {
    enabled: true,
    getShow: jest.fn(),
  };
  const service = new StructureAuthorityService(prisma as any, tmdb as any, tvdb as any);

  beforeEach(() => jest.clearAllMocks());

  it('routes strict TMDB anime to the verified TVDB series', async () => {
    tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 20,
      title: 'Anime',
      yearStart: 2020,
      genreIds: [16, 18],
      keywords: ['anime'],
      tvdbId: 200,
      imdbId: 'tt20',
    });
    await expect(service.forTmdb(20)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TVDB,
        reason: StructureReason.ANIME_TVDB,
        ruleVersion: STRUCTURE_RULE_VERSION,
        tvdbId: 200,
      }),
    );
  });

  it('keeps an equivalent general-TV graph on TMDB after comparing TVDB official order', async () => {
    tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 21,
      title: 'Animation',
      yearStart: 2020,
      genreIds: [16],
      keywords: ['family'],
      tvdbId: 201,
      imdbId: null,
    });
    tmdb.getShow.mockResolvedValue({ seasons: [regularSeason([1, 2])] });
    tvdb.getShow.mockResolvedValue({ seasons: [regularSeason([1, 2])] });
    await expect(service.forTmdb(21)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TMDB,
        reason: StructureReason.GENERAL_TMDB,
      }),
    );
    expect(tvdb.getShow).toHaveBeenCalledWith(201, 'en', { seasonType: 'official' });
  });

  it('routes a divergent general-TV graph to TVDB official order', async () => {
    tmdb.getShowRoutingProfile.mockResolvedValue({
      tmdbId: 22,
      title: 'General show',
      yearStart: 2020,
      genreIds: [18],
      keywords: [],
      tvdbId: 202,
      imdbId: null,
    });
    tmdb.getShow.mockResolvedValue({ seasons: [regularSeason([1])] });
    tvdb.getShow.mockResolvedValue({ seasons: [regularSeason([1, 2])] });

    await expect(service.forTmdb(22)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TVDB,
        reason: StructureReason.GENERAL_TVDB,
        tvdbId: 202,
        comparison: expect.objectContaining({ equivalent: false, tvdbOnlyCount: 1 }),
      }),
    );
  });

  it('uses a locked TVDB fallback when TMDB cannot resolve the TVDB series id', async () => {
    tmdb.findByExternalId.mockResolvedValue(null);
    await expect(service.forTvdb(300)).resolves.toEqual(
      expect.objectContaining({
        provider: StructureProvider.TVDB,
        reason: StructureReason.TVDB_ONLY_FALLBACK,
        tvdbId: 300,
      }),
    );
  });
});

function regularSeason(episodeNumbers: number[]) {
  return {
    number: 1,
    isSpecial: false,
    episodes: episodeNumbers.map((number) => ({ number, airDate: null })),
  };
}
