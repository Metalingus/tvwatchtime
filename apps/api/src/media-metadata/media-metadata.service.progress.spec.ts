import { MediaMetadataService } from './media-metadata.service';

describe('MediaMetadataService progress cache repair', () => {
  it('rebuilds both watched and total counts with undated official episodes eligible', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          watchedCount: 1047,
          totalCount: 1355,
          lastWatchedAt: new Date('2026-08-08T12:00:00.000Z'),
        },
      ]),
      userShowStatus: { upsert: jest.fn().mockResolvedValue({}) },
    };
    const service = Object.create(MediaMetadataService.prototype) as MediaMetadataService;
    (service as any).prisma = prisma;

    await service.ensureUserShowTotals('user-1', 'en-famille');

    const sql = (prisma.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
    expect(sql).toContain('(e.air_date IS NULL OR e.air_date <= NOW())');
    expect(prisma.userShowStatus.upsert).toHaveBeenCalledWith({
      where: { userId_mediaId: { userId: 'user-1', mediaId: 'en-famille' } },
      create: {
        userId: 'user-1',
        mediaId: 'en-famille',
        watchedCount: 1047,
        totalCount: 1355,
        lastWatchedAt: new Date('2026-08-08T12:00:00.000Z'),
      },
      update: {
        watchedCount: 1047,
        totalCount: 1355,
        lastWatchedAt: new Date('2026-08-08T12:00:00.000Z'),
      },
    });
  });
});
