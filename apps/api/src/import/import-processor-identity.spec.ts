import { ImportProcessor } from './import.processor';
import { ArchiveIdentityIndex } from './lib/archive-identity';

describe('ImportProcessor external episode identity', () => {
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
});
