import { ConflictException } from '@nestjs/common';
import { ImportMatcher } from './matcher';

const OWNED_ELSEWHERE = 'Identity is owned elsewhere; a verified repair is required';

function make() {
  const matcher: any = Object.create(ImportMatcher.prototype);
  matcher.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() };
  matcher.externalMediaCache = new Map();
  matcher.identities = {
    attachExternalId: jest.fn(async () => undefined),
    creationIdentities: jest.fn(async () => [
      { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt10' },
      { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '900' },
    ]),
  };
  matcher._hydrationQueue = { enqueueIdentityRepair: jest.fn(async () => undefined) };
  return matcher;
}

describe('ImportMatcher alias enrichment', () => {
  it('keeps a verified match when the alias is owned by another row and queues a repair', async () => {
    const matcher = make();
    matcher.identities.attachExternalId.mockRejectedValue(new ConflictException(OWNED_ELSEWHERE));
    matcher.findLocalMediaByExternalId = jest.fn(async (provider: string) =>
      provider === 'THE_TVDB' ? { id: 'tvdb-row', type: 'SHOW', title: 'Show' } : null,
    );
    await expect(
      matcher.matchShowByImdbCrosswalk('tt10', 'Show', 'show', 2020, null, null),
    ).resolves.toEqual({ mediaId: 'tvdb-row', confidence: 0.9, matchedTitle: 'Show' });
    expect(matcher._hydrationQueue.enqueueIdentityRepair).toHaveBeenCalledWith(
      'tvdb-row',
      'import-alias',
    );
  });

  it('survives an unavailable repair queue and still rethrows non-identity failures', async () => {
    const matcher = make();
    matcher.identities.attachExternalId.mockRejectedValueOnce(new ConflictException('guard'));
    matcher._hydrationQueue.enqueueIdentityRepair.mockRejectedValue(new Error('redis down'));
    await expect(matcher.attachExternalId('m', 'IMDB', 'SERIES', 'tt10')).resolves.toBeUndefined();
    matcher.identities.attachExternalId.mockRejectedValueOnce(new Error('connection reset'));
    await expect(matcher.attachExternalId('m', 'IMDB', 'SERIES', 'tt10')).rejects.toThrow(
      'connection reset',
    );
  });

  it('treats an episode id owned by another episode as an unproven TMDB recovery', async () => {
    const matcher = make();
    matcher.tmdb = {
      enabled: true,
      getSeasonEpisodeIdentities: jest.fn(async () => [{ episode: 3, tmdbId: 777 }]),
    };
    matcher.providerPref = new Map();
    matcher.verifiedTmdbShowIds = new Map([['show', 55]]);
    matcher.tmdbSeasonIdentityCache = new Map();
    matcher.resolveEpisode = jest.fn(async () => 'local-ep');
    matcher.attachEpisodeExternalId = jest.fn(async () => {
      throw new Error('Episode identity is owned elsewhere; reconciliation required');
    });
    await expect(matcher.recoverEpisodeByTmdbId('show', 55, 1, 3, 777)).resolves.toBeNull();
    matcher.attachEpisodeExternalId.mockResolvedValue(undefined);
    await expect(matcher.recoverEpisodeByTmdbId('show', 55, 1, 3, 777)).resolves.toBe('local-ep');
  });
});
