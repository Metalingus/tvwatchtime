import { ImportMatcher } from './matcher';

describe('ImportMatcher.reconcileStructureForMissingEpisodes', () => {
  function make(episodes: Array<{ number: number; season: { number: number } }>) {
    const prisma: any = {
      episode: { findMany: jest.fn(async () => episodes) },
    };
    const meta: any = {
      evaluateShowStructureAuthority: jest.fn(async () => ({
        evaluated: true,
        changed: true,
        blocked: false,
      })),
    };
    const matcher = new ImportMatcher(prisma, meta, {} as any, {} as any, undefined, undefined);
    return { matcher, meta };
  }

  it('runs strict authority repair when TMDB cannot represent TVDB S06E18', async () => {
    const { matcher, meta } = make([
      { number: 18, season: { number: 1 } },
      { number: 18, season: { number: 2 } },
    ]);

    await expect(
      matcher.reconcileStructureForMissingEpisodes('lost', [{ season: 6, episode: 18 }]),
    ).resolves.toEqual({ attempted: true, repaired: true, blocked: false });
    expect(meta.evaluateShowStructureAuthority).toHaveBeenCalledWith('lost');
  });

  it('does not evaluate authority when the manual anthology fallback is unambiguous', async () => {
    const { matcher, meta } = make([{ number: 9, season: { number: 1 } }]);

    await expect(
      matcher.reconcileStructureForMissingEpisodes('bly-manor', [{ season: 2, episode: 9 }]),
    ).resolves.toEqual({ attempted: false, repaired: false, blocked: false });
    expect(meta.evaluateShowStructureAuthority).not.toHaveBeenCalled();
  });

  it('reports an all-or-nothing gate without claiming the structure was repaired', async () => {
    const { matcher, meta } = make([]);
    meta.evaluateShowStructureAuthority.mockResolvedValue({
      evaluated: true,
      changed: true,
      blocked: true,
    });

    await expect(
      matcher.reconcileStructureForMissingEpisodes('blocked-show', [{ season: 7, episode: 7 }]),
    ).resolves.toEqual({ attempted: true, repaired: false, blocked: true });
  });
});
