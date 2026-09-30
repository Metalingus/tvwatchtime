import { MediaReconciler } from './media-reconciler.service';

const tmdb = { provider: 'TMDB', providerEntityKind: 'SERIES', value: '208891' };
const tvdb = { provider: 'THE_TVDB', providerEntityKind: 'SERIES', value: '426165' };
function setup() {
  const prisma = {
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'source',
        type: 'SHOW',
        externalIds: [tmdb],
      }),
    },
    externalId: {
      findMany: jest.fn().mockResolvedValue([
        { ...tmdb, mediaId: 'source', media: { type: 'SHOW' } },
        { ...tvdb, mediaId: 'other', media: { type: 'SHOW' } },
      ]),
    },
  };
  const client = {
    lookup: jest.fn().mockResolvedValue({
      status: 'found',
      identity: {
        wfId: '12076',
        ids: { tmdb: ['208891'], tvdb: ['426165'], imdb: [], tvtime_uuid: [] },
      },
    }),
  };
  return { prisma, client, service: new MediaReconciler(prisma as any, {} as any, client as any) };
}
describe('MediaReconciler identity inspection', () => {
  it('reports an occupied alias without attaching IDs, hydrating, or reading imports', async () => {
    const f = setup();
    expect(await f.service.inspectMedia('source')).toMatchObject({
      status: 'owned_elsewhere',
      complete: true,
      families: [{ wfId: '12076', ownerMediaIds: ['source', 'other'] }],
    });
    expect(f.prisma.mediaItem.findUnique).toHaveBeenCalledTimes(1);
    expect(f.prisma.externalId.findMany).toHaveBeenCalledTimes(1);
  });

  it('inspects every alias and exposes different catalog identities on one local row', async () => {
    const f = setup();
    f.prisma.mediaItem.findUnique.mockResolvedValue({
      id: 'source',
      type: 'SHOW',
      externalIds: [tmdb, tvdb],
    });
    f.client.lookup
      .mockResolvedValueOnce({
        status: 'found',
        identity: { wfId: '1', ids: { tmdb: ['208891'], tvdb: [], imdb: [], tvtime_uuid: [] } },
      })
      .mockResolvedValueOnce({
        status: 'found',
        identity: { wfId: '2', ids: { tmdb: [], tvdb: ['426165'], imdb: [], tvtime_uuid: [] } },
      });
    expect(await f.service.inspectMedia('source')).toMatchObject({
      status: 'conflict',
      complete: true,
    });
    expect(f.client.lookup).toHaveBeenCalledTimes(2);
  });

  it('does not turn a partial provider failure into a successful identity decision', async () => {
    const f = setup();
    f.client.lookup.mockResolvedValue({ status: 'deferred', reason: 'quota' });
    expect(await f.service.inspectMedia('source')).toMatchObject({
      status: 'deferred',
      complete: false,
    });
    expect(f.prisma.externalId.findMany).not.toHaveBeenCalled();
  });

  it('reports wrong-kind aliases without sending their numeric ID to the wrong namespace', async () => {
    const f = setup();
    f.prisma.mediaItem.findUnique.mockResolvedValue({
      id: 'source',
      type: 'MOVIE',
      externalIds: [tmdb],
    });
    expect(await f.service.inspectMedia('source')).toMatchObject({
      status: 'conflict',
      wrongKind: [tmdb],
    });
    expect(f.client.lookup).not.toHaveBeenCalled();
  });
});
