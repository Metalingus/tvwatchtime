import { ConflictException } from '@nestjs/common';
import { fenceIdentityWrite } from './identity-write-fence';

function tx(
  row: { id: string; type: 'SHOW' | 'MOVIE'; show?: object | null; movie?: object | null },
  opts: { retired?: boolean } = {},
) {
  return {
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
    episode: {
      findMany: jest.fn(async () => [
        { id: 'e1', structureState: 'ACTIVE', season: { show: { mediaId: row.id } } },
      ]),
    },
    mediaCanonicalLink: {
      findMany: jest.fn(async () => (opts.retired ? [{ sourceMediaId: row.id }] : [])),
    },
    mediaItem: {
      findMany: jest.fn(async () => [{ show: null, movie: null, ...row }]),
    },
  } as any;
}

describe('fenceIdentityWrite', () => {
  it('accepts own-type writes on a movie row that still carries a stray show graph', async () => {
    const movie = tx({ id: 'm', type: 'MOVIE', show: { id: 's' } });
    await expect(fenceIdentityWrite(movie, { mediaIds: ['m'] })).resolves.toBeUndefined();
    await expect(
      fenceIdentityWrite(movie, { mediaIds: ['m'], type: 'MOVIE', userId: 'u' }),
    ).resolves.toBeUndefined();
  });

  it('refuses show writes on that movie row and episode writes into its stray graph', async () => {
    const movie = tx({ id: 'm', type: 'MOVIE', show: { id: 's' } });
    await expect(
      fenceIdentityWrite(movie, { mediaIds: ['m'], type: 'SHOW', userId: 'u' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(fenceIdentityWrite(movie, { episodeIds: ['e1'] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('accepts episode writes on a show row whose stray part is a movie row', async () => {
    const show = tx({ id: 'sh', type: 'SHOW', movie: { id: 'mv' } });
    await expect(
      fenceIdentityWrite(show, { episodeIds: ['e1'], type: 'SHOW', userId: 'u' }),
    ).resolves.toBeUndefined();
  });

  it('refuses any write to a merged-away (redirected) row', async () => {
    const hidden = tx({ id: 'm', type: 'MOVIE' }, { retired: true });
    await expect(fenceIdentityWrite(hidden, { mediaIds: ['m'] })).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
