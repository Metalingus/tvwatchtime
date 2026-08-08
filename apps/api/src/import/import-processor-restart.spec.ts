import { ImportProcessor } from './import.processor';

describe('ImportProcessor interrupted staging recovery', () => {
  function setup(status: string) {
    const prisma: any = {
      import: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'imp-1',
          status,
          locale: 'en',
          storageKey: 'imports/imp-1.zip',
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      importItem: { deleteMany: jest.fn().mockResolvedValue({ count: 12 }) },
      importFile: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
      $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
    };
    const storage = { read: jest.fn().mockRejectedValue(new Error('stop after recovery')) };
    const processor = new ImportProcessor(
      {} as any,
      prisma,
      storage as any,
      {} as any,
      {} as any,
    );
    return { prisma, processor };
  }

  it('clears only partial staging rows before BullMQ replays an interrupted import', async () => {
    const { prisma, processor } = setup('MATCHING');

    await processor.run('imp-1');

    expect(prisma.importItem.deleteMany).toHaveBeenCalledWith({ where: { importId: 'imp-1' } });
    expect(prisma.importFile.deleteMany).toHaveBeenCalledWith({ where: { importId: 'imp-1' } });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not clear staging on the first processing attempt', async () => {
    const { prisma, processor } = setup('UPLOADED');

    await processor.run('imp-1');

    expect(prisma.importItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.importFile.deleteMany).not.toHaveBeenCalled();
  });
});
