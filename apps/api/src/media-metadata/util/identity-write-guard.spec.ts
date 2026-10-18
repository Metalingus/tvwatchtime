import { assertMediaIdentityWrite, wouldAddConflictingAlias } from './identity-write-guard';
import { canonicalCopyId, canonicalMediaId } from './canonical-media';

const tmdb = { provider: 'TMDB', providerEntityKind: 'MOVIE', value: '155' };
function make(over: Record<string, unknown> = {}) {
  return {
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({
        type: 'MOVIE',
        show: null,
        movie: { id: 'movie' },
        canonicalSource: null,
        externalIds: [tmdb],
        ...over,
      }),
    },
    externalId: { findFirst: jest.fn().mockResolvedValue({ mediaId: 'movie' }) },
  };
}
describe('Shared identity write boundary', () => {
  it('accepts the current typed primary owner', async () => {
    await expect(
      assertMediaIdentityWrite(make() as any, 'movie', 'MOVIE', [tmdb], 'TMDB'),
    ).resolves.toBeUndefined();
  });
  it.each([
    { show: { id: 'stray' } },
    { canonicalSource: { status: 'ACTIVE' } },
    { type: 'SHOW' },
    { externalIds: [tmdb, { ...tmdb, value: '999' }] },
    { externalIds: [tmdb, { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '1' }] },
  ])('blocks incompatible local state %s', async (over) => {
    await expect(
      assertMediaIdentityWrite(make(over) as any, 'movie', 'MOVIE', [tmdb]),
    ).rejects.toThrow();
  });
  it('lets an exact restore land on a row awaiting repair, never a wrong or redirected one', async () => {
    const tolerate = { exactRestore: true };
    for (const over of [
      { externalIds: [tmdb, { ...tmdb, value: '999' }] },
      { externalIds: [tmdb, { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '1' }] },
      { show: { id: 'stray' } },
    ]) {
      await expect(
        assertMediaIdentityWrite(make(over) as any, 'movie', 'MOVIE', [], undefined, tolerate),
      ).resolves.toBeUndefined();
    }
    for (const over of [{ type: 'SHOW' }, { canonicalSource: { status: 'ACTIVE' } }]) {
      await expect(
        assertMediaIdentityWrite(make(over) as any, 'movie', 'MOVIE', [], undefined, tolerate),
      ).rejects.toThrow();
    }
  });
  it('blocks a competing primary owner', async () => {
    const db = make();
    db.externalId.findFirst.mockResolvedValue({ mediaId: 'other' });
    await expect(
      assertMediaIdentityWrite(db as any, 'movie', 'MOVIE', [tmdb], 'TMDB'),
    ).rejects.toThrow('owned');
  });
  it('resolves typed split redirects without redirecting the original movie', async () => {
    const db = {
      mediaItem: {
        findUnique: jest.fn(async ({ where }: any) =>
          where.id === 'movie'
            ? {
                type: 'MOVIE',
                metadataProvenance: { identitySplit: { targets: { SHOW: 'show' } } },
              }
            : { type: 'SHOW' },
        ),
      },
    };
    expect(await canonicalMediaId(db as any, 'movie', 'SHOW')).toBe('show');
    expect(await canonicalMediaId(db as any, 'movie', 'MOVIE')).toBe('movie');
  });
  it('rejects cyclic redirects', async () => {
    const db = {
      mediaCanonicalLink: {
        findUnique: jest.fn(async ({ where }: any) => ({
          status: 'ACTIVE',
          targetMediaId: where.sourceMediaId === 'a' ? 'b' : 'a',
        })),
      },
    };
    await expect(canonicalMediaId(db as any, 'a')).rejects.toThrow('Cyclic');
  });
  it('does not resolve a combined broadcast to just its first copied part', async () => {
    const db = {
      mediaCanonicalCopy: {
        findMany: jest.fn(async ({ where }: any) =>
          where.sourceId.in.includes('combined')
            ? [
                { sourceId: 'combined', targetId: 'part1' },
                { sourceId: 'combined', targetId: 'part2' },
              ]
            : [],
        ),
        findFirst: jest.fn(),
      },
    };
    await expect(canonicalCopyId(db as any, 'EPISODE', 'combined')).rejects.toThrow('split');
    expect(db.mediaCanonicalCopy.findFirst).not.toHaveBeenCalled();
  });
});

describe('wouldAddConflictingAlias', () => {
  const db = (stored: Array<{ provider: string; kind: string; value: string }>) => ({
    externalId: {
      findFirst: jest.fn(async ({ where }: any) =>
        stored.find(
          (id) =>
            id.provider === where.provider &&
            id.kind === where.providerEntityKind &&
            id.value !== where.value.not,
        )
          ? { id: 'other' }
          : null,
      ),
    },
  });

  it('refuses a second, different primary-provider alias of the same kind', async () => {
    const d = db([{ provider: 'THE_TVDB', kind: 'SERIES', value: '361140' }]);
    await expect(
      wouldAddConflictingAlias(d as any, 'm', 'THE_TVDB', 'SERIES', '473467'),
    ).resolves.toBe(true);
  });

  it('allows re-attaching the same alias, a first alias, or another kind/provider', async () => {
    const d = db([{ provider: 'THE_TVDB', kind: 'SERIES', value: '473467' }]);
    await expect(
      wouldAddConflictingAlias(d as any, 'm', 'THE_TVDB', 'SERIES', '473467'),
    ).resolves.toBe(false);
    await expect(wouldAddConflictingAlias(d as any, 'm', 'TMDB', 'SERIES', '111111')).resolves.toBe(
      false,
    );
    await expect(wouldAddConflictingAlias(d as any, 'm', 'THE_TVDB', 'MOVIE', '9')).resolves.toBe(
      false,
    );
    await expect(wouldAddConflictingAlias(d as any, 'm', 'TV_TIME', 'MOVIE', 'uuid')).resolves.toBe(
      false,
    );
  });
});
