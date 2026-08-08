import { MetadataBackfillService } from './metadata-backfill.service';
import { CastDedupService } from './cast-dedup.service';
import { StructureRemapService } from './structure-remap.service';

// repairTmdbStructureShow: the reverse (TMDB-canonical) structure repair — gating,
// rehydration, remap direction, and provenance stamps.

const REMAP_ZERO = {
  stale: 0,
  mapped: 0,
  unmapped: 0,
  statusesMoved: 0,
  historiesMoved: 0,
  ratingsMoved: 0,
  reactionsMoved: 0,
  votesMoved: 0,
  commentsMoved: 0,
  episodesRemoved: 0,
  seasonsRemoved: 0,
  matchRules: {},
  dryRun: false,
};

function make(opts: {
  staleRows: number;
  provenance?: any;
  externalIds?: any[];
  remap?: Partial<typeof REMAP_ZERO>;
}) {
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ c: BigInt(opts.staleRows) }]),
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'm1',
        metadataProvenance: opts.provenance ?? null,
        externalIds: opts.externalIds ?? [
          { provider: 'TMDB', providerEntityKind: 'SERIES', value: '1416' },
        ],
      }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const meta: any = { ensureShowFull: jest.fn().mockResolvedValue('m1') };
  const structureRemap: any = {
    remapShow: jest.fn().mockResolvedValue({ ...REMAP_ZERO, ...opts.remap }),
  };
  const redis: any = {
    client: {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    },
  };
  const svc = new MetadataBackfillService(
    prisma,
    meta,
    {} as any,
    redis,
    {} as any,
    {} as any,
    {} as any,
    structureRemap,
    new CastDedupService(),
  );
  return { svc, prisma, meta, structureRemap };
}

describe('repairTmdbStructureShow', () => {
  it('does nothing when no TMDB-unlinked rows exist', async () => {
    const { svc, meta, structureRemap } = make({ staleRows: 0 });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(false);
    expect(meta.ensureShowFull).not.toHaveBeenCalled();
    expect(structureRemap.remapShow).not.toHaveBeenCalled();
  });

  it('rehydrates from TMDB and remaps with canonical=tmdb, then stamps provenance', async () => {
    const { svc, prisma, meta, structureRemap } = make({
      staleRows: 5,
      remap: { stale: 5, mapped: 5, unmapped: 0 },
    });
    const res = await (svc as any).repairTmdbStructureShow('m1');

    expect(res).toMatchObject({ fixed: true, remapped: 5, report: { mapped: 5 } });
    expect(meta.ensureShowFull).toHaveBeenCalledWith(
      1416,
      undefined,
      expect.objectContaining({ forceRefresh: true, writeScope: 'STRUCTURE_REMAP' }),
    );
    expect(structureRemap.remapShow).toHaveBeenCalledWith(
      'm1',
      expect.objectContaining({ canonical: 'tmdb', onProgress: expect.any(Function) }),
    );
    expect(prisma.mediaItem.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        metadataProvenance: {
          structureProvider: 'tmdb',
          structureRemapVersion: StructureRemapService.MATCHER_VERSION,
        },
      },
    });
  });

  it('re-arms quarantined legacy rows when the matcher version increases', async () => {
    const { svc, prisma, structureRemap } = make({
      staleRows: 1,
      provenance: { structureRemapVersion: StructureRemapService.MATCHER_VERSION - 1 },
      remap: { stale: 1, mapped: 1 },
    });

    const result = await (svc as any).repairTmdbStructureShow('m1');

    // Prisma tagged-template interpolations include the legacy-reconsideration gate.
    // Before this regression fix the query was active-only and had no such true flag.
    expect(prisma.$queryRaw.mock.calls[0]).toContain(true);
    expect(structureRemap.remapShow).toHaveBeenCalled();
    expect(result).toMatchObject({ fixed: true, remapped: 1 });
  });

  it('returns notFixed when nothing was stale and no TMDB id anchors the show', async () => {
    const { svc } = make({ staleRows: 1, externalIds: [], remap: { stale: 0 } });
    const res = await (svc as any).repairTmdbStructureShow('m1');
    expect(res.fixed).toBe(false);
  });
});

describe('reconcileStructures', () => {
  it('reports a targeted media id that no longer exists instead of a successful no-op', async () => {
    const { svc, prisma } = make({ staleRows: 0 });
    prisma.mediaItem.findUnique.mockResolvedValue(null);

    const result = await svc.reconcileStructures({ mode: 'dry-run', mediaId: 'missing-media' });

    expect(result).toMatchObject({
      processed: 1,
      failed: 1,
      titlesTotal: 1,
      titles: [
        expect.objectContaining({ mediaId: 'missing-media', action: 'not-found' }),
      ],
    });
  });
});
