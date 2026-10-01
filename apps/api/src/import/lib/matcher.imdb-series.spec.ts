import { ConflictException } from '@nestjs/common';
import { ImportMatcher } from './matcher';

const ids = (tmdb?: string, tvdb?: string) => [
  { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt10' },
  ...(tmdb ? [{ provider: 'TMDB', providerEntityKind: 'SERIES', value: tmdb }] : []),
  ...(tvdb ? [{ provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: tvdb }] : []),
];

function make(local: Record<string, { id: string; type: string; title: string }> = {}) {
  const matcher: any = Object.create(ImportMatcher.prototype);
  matcher.logger = { warn: jest.fn(), debug: jest.fn(), log: jest.fn() };
  matcher.identities = { creationIdentities: jest.fn(async () => ids('10', '900')) };
  matcher.meta = { lightUpsertShow: jest.fn(async () => 'new-show') };
  matcher.findLocalMediaByExternalId = jest.fn(
    async (provider: string, _kind: string, value: string) => local[`${provider}:${value}`] ?? null,
  );
  matcher.attachExternalId = jest.fn(async () => undefined);
  matcher.matchMedia = jest.fn(async () => ({
    mediaId: 'gate',
    confidence: 0.9,
    matchedTitle: 'S',
  }));
  const run = () =>
    matcher.matchShowByImdbCrosswalk('tt10', 'Show', 'show', 2020, null, null) as Promise<any>;
  return { matcher, run };
}

describe('ImportMatcher IMDb-only series crosswalk', () => {
  it('uses the shared TVDB-first crosswalk with a verified TMDB link and no WatchForge', async () => {
    const { matcher, run } = make();
    await expect(run()).resolves.toEqual({
      mediaId: 'new-show',
      confidence: 0.9,
      matchedTitle: 'Show',
    });
    expect(matcher.identities.creationIdentities).toHaveBeenCalledWith(
      { provider: 'IMDB', providerEntityKind: 'SERIES', value: 'tt10' },
      'THE_TVDB',
      { verifyTvdbLink: true, watchforgeLane: null },
    );
    expect(matcher.meta.lightUpsertShow).toHaveBeenCalledWith(
      { tmdbId: 10, title: 'Show', year: 2020 },
      { verifyTvdbLink: true },
    );
  });

  it('reuses an existing TVDB-only row instead of creating a TMDB duplicate', async () => {
    const { matcher, run } = make({ 'THE_TVDB:900': { id: 'tvdb-row', type: 'SHOW', title: 'S' } });
    await expect(run()).resolves.toMatchObject({ mediaId: 'tvdb-row' });
    expect(matcher.meta.lightUpsertShow).not.toHaveBeenCalled();
    expect(matcher.attachExternalId).toHaveBeenCalledWith('tvdb-row', 'IMDB', 'SERIES', 'tt10');
  });

  it('sends two different local rows or disagreeing providers to review', async () => {
    const both = make({
      'TMDB:10': { id: 'row-a', type: 'SHOW', title: 'A' },
      'THE_TVDB:900': { id: 'row-b', type: 'SHOW', title: 'B' },
    });
    await expect(both.run()).resolves.toEqual({
      mediaId: null,
      confidence: 0.6,
      matchedTitle: null,
    });
    const conflict = make();
    conflict.matcher.identities.creationIdentities.mockRejectedValue(
      new ConflictException('Provider identities disagree'),
    );
    await expect(conflict.run()).resolves.toMatchObject({ mediaId: null });
  });

  it('routes a TVDB-only result through the TVDB authority gate', async () => {
    const { matcher, run } = make();
    matcher.identities.creationIdentities.mockResolvedValue(ids(undefined, '900'));
    await expect(run()).resolves.toMatchObject({ mediaId: 'gate' });
    expect(matcher.matchMedia).toHaveBeenCalledWith(
      'show',
      'Show',
      'SHOW',
      2020,
      null,
      null,
      '900',
      ['900'],
    );
  });

  it('falls back to the legacy path when the crosswalk is unavailable or empty', async () => {
    const outage = make();
    outage.matcher.identities.creationIdentities.mockRejectedValue(new Error('timeout'));
    await expect(outage.run()).resolves.toBeNull();
    const empty = make();
    empty.matcher.identities.creationIdentities.mockResolvedValue(ids());
    await expect(empty.run()).resolves.toBeNull();
    const none = make();
    none.matcher.identities = undefined;
    await expect(none.run()).resolves.toBeNull();
  });
});
