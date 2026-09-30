import {
  canonicalEpisodeTargets,
  canonicalEpisodeTargetMap,
  recordEpisodeRemap,
  episodeAliasKey,
} from './episode-identity';
import { canonicalCopyId } from './canonical-media';

function fixture() {
  const rows: any[] = [];
  const db: any = {
    mediaCanonicalCopy: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((row) => where.sourceId.in.includes(row.sourceId)),
      ),
      findUnique: jest.fn(
        async ({ where }: any) => rows.find((row) => row.mappingKey === where.mappingKey) ?? null,
      ),
      upsert: jest.fn(async ({ create }: any) => {
        rows.push(create);
        return create;
      }),
    },
  };
  return { db, rows };
}
describe('durable episode identity', () => {
  it('preserves all parts when one part is subsequently remapped', async () => {
    const { db } = fixture(),
      alias = episodeAliasKey('THE_TVDB', '123');
    await recordEpisodeRemap(
      db,
      'combined',
      ['part1', 'part2'],
      [{ provider: 'THE_TVDB', value: '123' }],
      1,
    );
    await recordEpisodeRemap(db, 'part1', ['part3'], [{ provider: 'THE_TVDB', value: '123' }], 2);
    expect((await canonicalEpisodeTargets(db, alias)).sort()).toEqual(['part2', 'part3']);
    await expect(canonicalCopyId(db, 'EPISODE', 'combined')).rejects.toThrow('split');
    await recordEpisodeRemap(db, 'combined', ['part1'], [], 2);
    expect((await canonicalEpisodeTargets(db, 'combined')).sort()).toEqual(['part2', 'part3']);
  });
  it('records a verified external alias directly to a local episode and follows later remaps', async () => {
    const { db } = fixture();
    await recordEpisodeRemap(
      db,
      'episode',
      ['episode'],
      [{ provider: 'THE_TVDB', value: '123' }],
      1,
      false,
    );
    expect(await canonicalEpisodeTargets(db, episodeAliasKey('THE_TVDB', '123'))).toEqual([
      'episode',
    ]);
    await recordEpisodeRemap(db, 'episode', ['new-episode'], [], 2);
    expect(await canonicalEpisodeTargets(db, episodeAliasKey('THE_TVDB', '123'))).toEqual([
      'new-episode',
    ]);
  });
  it('batches unchanged import IDs instead of looking each up separately', async () => {
    const { db } = fixture(),
      ids = Array.from({ length: 12000 }, (_, i) => 'e' + i);
    const result = await canonicalEpisodeTargetMap(db, ids);
    expect(result.get('e11999')).toEqual(['e11999']);
    expect(db.mediaCanonicalCopy.findMany).toHaveBeenCalledTimes(3);
  });
  it('rejects loops instead of silently returning a stale target', async () => {
    const { db } = fixture();
    await recordEpisodeRemap(db, 'a', ['b'], [], 1);
    await recordEpisodeRemap(db, 'b', ['a'], [], 1);
    await expect(canonicalEpisodeTargets(db, 'a')).rejects.toThrow('Cyclic');
  });
});
