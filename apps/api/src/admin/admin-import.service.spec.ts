import { AdminImportService } from './admin-import.service';

const owner = {
  userId: 'user-1',
  user: {
    id: 'user-1',
    username: 'viewer',
    email: 'viewer@example.test',
    profile: null,
  },
};

const setup = () => {
  const prisma: any = {
    import: {
      findUnique: jest.fn(async () => owner),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
  };
  const imports: any = {
    getStatus: jest.fn(),
    getItems: jest.fn(),
    patchItem: jest.fn(),
    resolveByName: jest.fn(),
    confirm: jest.fn(),
  };
  const admin: any = { audit: jest.fn(async () => undefined) };
  return { prisma, imports, admin, service: new AdminImportService(prisma, imports, admin) };
};

describe('AdminImportService', () => {
  it('lists imports with bounded pagination and user search', async () => {
    const { prisma, service } = setup();

    await service.list({ search: 'viewer', status: 'ready_for_review', page: 2, pageSize: 999 });

    expect(prisma.import.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'READY_FOR_REVIEW', OR: expect.any(Array) }),
        skip: 200,
        take: 200,
      }),
    );
  });

  it('uses the import owner for review and never returns raw provider rows', async () => {
    const { imports, service } = setup();
    imports.getItems.mockResolvedValue({
      items: [
        {
          id: 'item-1',
          normalizedData: { title: 'Example' },
          rawData: { privateProviderBlob: true },
        },
      ],
      total: 1,
      page: 1,
      pageSize: 500,
    });

    const result = await service.items('import-1', { status: 'needs_review', pageSize: 500 });

    expect(imports.getItems).toHaveBeenCalledWith(
      'user-1',
      'import-1',
      expect.objectContaining({ status: 'needs_review', pageSize: 500 }),
    );
    expect(result.items[0]).not.toHaveProperty('rawData');
    expect(result.items[0]).toMatchObject({ normalizedData: { title: 'Example' } });
  });

  it('auto-resolves and confirms through the existing owner-scoped pipeline with audit logs', async () => {
    const { imports, admin, service } = setup();
    imports.resolveByName.mockResolvedValue({ examined: 5, resolved: 4, stillUnresolved: 1 });
    imports.confirm.mockResolvedValue({ importId: 'import-1', created: 20, skipped: 1 });

    await service.autoResolve('admin-1', 'import-1', { entity: 'WATCHED_EPISODE' });
    await service.confirm('admin-1', 'import-1');

    expect(imports.resolveByName).toHaveBeenCalledWith('user-1', 'import-1', {
      entity: 'WATCHED_EPISODE',
    });
    expect(imports.confirm).toHaveBeenCalledWith('user-1', 'import-1');
    expect(admin.audit).toHaveBeenCalledWith(
      'admin-1',
      'admin_import_auto_resolve',
      'import',
      'import-1',
      expect.objectContaining({ userId: 'user-1' }),
    );
    expect(admin.audit).toHaveBeenCalledWith(
      'admin-1',
      'admin_import_confirm',
      'import',
      'import-1',
      expect.objectContaining({ created: 20, skipped: 1 }),
    );
  });
});
