import { ImportService } from './import.service';
import { ImportMatcher } from './lib/matcher';
import { IMPORT_CANCELLED_PENDING_ERROR } from './lib/structure-pending';

describe('cancelling an import settles its parked rows', () => {
  function setup(status: string) {
    const prisma: any = {
      import: {
        findFirst: jest.fn(async () => ({ id: 'imp', userId: 'user', status })),
        update: jest.fn(async ({ data }: any) => ({ id: 'imp', ...data })),
      },
      importItem: { updateMany: jest.fn(async () => ({ count: 2 })) },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    const none = {} as any;
    const service = new ImportService(prisma, none, none, none, none, none, none, none, none);
    return { service, prisma };
  }

  it('marks the import cancelled and hides its scheduled-for-match rows as skips', async () => {
    const f = setup('READY_FOR_REVIEW');
    await expect(f.service.cancel('user', 'imp')).resolves.toMatchObject({ status: 'CANCELLED' });
    expect(f.prisma.importItem.updateMany).toHaveBeenCalledWith({
      where: { importId: 'imp', status: 'PENDING_MATCH' },
      data: { status: 'SKIPPED', errorMessage: IMPORT_CANCELLED_PENDING_ERROR },
    });
    expect(f.prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('refuses to cancel a completed import and leaves its rows alone', async () => {
    const f = setup('COMPLETED');
    await expect(f.service.cancel('user', 'imp')).rejects.toThrow('cannot be cancelled');
    expect(f.prisma.importItem.updateMany).not.toHaveBeenCalled();
  });
});

describe('ImportMatcher.hasStoredEpisodeAlias', () => {
  function matcherWith(aliasOwner: string | null, redirects: Record<string, string> = {}) {
    const prisma: any = {
      mediaCanonicalCopy: {
        findMany: jest.fn(async ({ where }: any) =>
          (where.sourceId.in as string[])
            .filter((id) => redirects[id])
            .map((id) => ({ sourceId: id, targetId: redirects[id] })),
        ),
      },
      episodeExternalId: {
        findFirst: jest.fn(async () => (aliasOwner ? { episodeId: aliasOwner } : null)),
      },
    };
    return new ImportMatcher(prisma, {} as any, {} as any, {} as any);
  }

  it('accepts the episode that owns the stored TVDB alias', async () => {
    await expect(
      matcherWith('berlin-s01e01').hasStoredEpisodeAlias('berlin-s01e01', '10427042'),
    ).resolves.toBe(true);
  });

  it('follows canonical episode redirects to the owner', async () => {
    const matcher = matcherWith('old-episode', { 'old-episode': 'berlin-s01e01' });
    await expect(matcher.hasStoredEpisodeAlias('berlin-s01e01', 10427042)).resolves.toBe(true);
  });

  it('rejects an episode the alias does not belong to, or a missing alias', async () => {
    await expect(
      matcherWith('another-episode').hasStoredEpisodeAlias('berlin-s01e01', '10427042'),
    ).resolves.toBe(false);
    await expect(
      matcherWith(null).hasStoredEpisodeAlias('berlin-s01e01', '10427042'),
    ).resolves.toBe(false);
    await expect(
      matcherWith('berlin-s01e01').hasStoredEpisodeAlias('berlin-s01e01', null),
    ).resolves.toBe(false);
  });
});
