import { IdentityRepairService } from './identity-repair.service';
import { IdentityAuditStore } from './identity-audit.store';

jest.mock('./identity-transfer-manifest', () => ({
  IdentityTransferManifest: jest.fn().mockImplementation(() => ({
    summary: async () => ({ blocked: false, relations: [], unsafe: {} }),
  })),
}));

function make() {
  const records = new Map<string, any>();
  const clone = (v: any) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const prisma: any = {
    $queryRaw: jest.fn(async (query: any) => {
      if (query.sql?.includes('FROM admin_audit_logs WHERE')) {
        const row = records.get(query.values[0]);
        return row ? [{ ...row, actorId: row.adminId }] : [];
      }
      return [];
    }),
    adminAuditLog: {
      create: jest.fn(async ({ data }: any) => {
        records.set(data.id, clone(data));
        return clone(data);
      }),
      findUnique: jest.fn(async ({ where }: any) => clone(records.get(where.id) ?? null)),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const row = records.get(where.id);
        if (!row) throw Error('missing');
        return clone(row);
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = { ...records.get(where.id), ...clone(data) };
        records.set(where.id, row);
        return clone(row);
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    client: { set: jest.fn().mockResolvedValue('OK'), eval: jest.fn().mockResolvedValue(1) },
  };
  const canonical = {
    identityFamily: jest.fn(async (_members: any, _target: any, options: any) => {
      await options.commit(prisma);
      return { status: 'applied', activated: 1 };
    }),
    splitIdentity: jest.fn(async (_source: any, options: any) => {
      await options.commit(prisma);
      return { status: 'applied' };
    }),
  };
  const hydration = {
    enqueueIdentityRefresh: jest.fn().mockResolvedValue({}),
    enqueueIdentityApply: jest.fn().mockResolvedValue({}),
  };
  const service = new IdentityRepairService(
    prisma,
    redis as any,
    {} as any,
    canonical as any,
    hydration as any,
    {} as any,
    {} as any,
  );
  const plan = jest.spyOn(service as any, 'plan').mockResolvedValue({
    status: 'ready',
    fingerprint: 'stable',
    mediaId: 'source',
    targetMediaId: 'target',
    members: ['source', 'target'],
    action: 'consolidate',
    transferFingerprint: 'graph',
    familyOptions: { verifiedIds: [] },
    impact: { history: 1 },
  });
  return { service, prisma, records, redis, canonical, hydration, plan };
}
describe('IdentityRepairService durable reviewed apply', () => {
  it('retains quarantined claims when a later refresh replaces the repair summary', async () => {
    const { service, prisma, plan } = make();
    const claims = [{ provider: 'IMDB', providerEntityKind: 'MOVIE', value: 'tt1000' }];
    const state = {
      type: 'MOVIE',
      externalIds: [],
      metadataProvenance: { identityRepair: { quarantinedAliases: claims } },
    };
    prisma.mediaItem = {
      findUniqueOrThrow: jest.fn().mockResolvedValue(state),
      findUnique: jest
        .fn()
        .mockResolvedValue({ ...state, show: null, movie: { id: 'm' }, canonicalSource: null }),
      update: jest.fn(),
    };
    plan.mockResolvedValue({
      status: 'ready',
      fingerprint: 'stable',
      localFingerprint: (service as any).stateFingerprint(state),
      mediaId: 'm',
      targetMediaId: 'm',
      members: ['m'],
      verifiedIds: [],
      removeAliasIds: [],
      action: 'refresh',
    });
    const p = await service.preview({ mediaId: 'm' }, 'admin');
    await service.apply(p.token!, 'admin');
    expect(
      prisma.mediaItem.update.mock.calls[0][0].data.metadataProvenance.identityQuarantinedAliases,
    ).toEqual(claims);
  });
  it('retains blocked provider evidence for review without issuing an apply token', async () => {
    const { service, plan, records } = make();
    plan.mockResolvedValue({ mediaId: 'm', status: 'deferred', reason: 'quota' });
    const p = await service.preview({ mediaId: 'm' }, 'admin');
    expect(p).toMatchObject({ token: null, status: 'deferred' });
    expect(records.get(p.reviewId).metadata.status).toBe('deferred');
  });
  it('binds apply to its administrator', async () => {
    const { service, canonical } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    await expect(service.apply(p.token!, 'other')).rejects.toThrow('not found');
    expect(canonical.identityFamily).not.toHaveBeenCalled();
  });
  it('rejects stale identity evidence before any mutation', async () => {
    const { service, plan, canonical } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    plan.mockResolvedValue({ status: 'ready', fingerprint: 'changed' });
    await expect(service.apply(p.token!, 'admin')).rejects.toThrow('changed');
    expect(canonical.identityFamily).not.toHaveBeenCalled();
  });
  it('survives a Redis outage after commit without applying twice', async () => {
    const { service, hydration, canonical, redis } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    hydration.enqueueIdentityRefresh.mockRejectedValue(new Error('queue down'));
    const first = await service.apply(p.token!, 'admin');
    expect(first).toMatchObject({ followUp: 'retry-required' });
    redis.client.set.mockRejectedValue(new Error('redis restarted'));
    await expect(service.apply(p.token!, 'admin')).resolves.toEqual(first);
    expect(canonical.identityFamily).toHaveBeenCalledTimes(1);
  });
  it('does not queue metadata when copying is blocked', async () => {
    const { service, canonical, hydration } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    canonical.identityFamily.mockImplementation(
      async () => ({ status: 'blocked', reason: 'unmapped-protected-episodes' }) as any,
    );
    await expect(service.apply(p.token!, 'admin')).rejects.toThrow('unmapped-protected-episodes');
    expect(hydration.enqueueIdentityRefresh).not.toHaveBeenCalled();
  });
  it('rejects expired uncommitted previews', async () => {
    const { service, records } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    records.get(p.token!).metadata.expiresAt = new Date(0).toISOString();
    await expect(service.apply(p.token!, 'admin')).rejects.toThrow('expired');
  });
  it('does not erase a fast worker completion while recording the enqueue result', async () => {
    const { service, prisma, hydration } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    hydration.enqueueIdentityRefresh.mockImplementation(async (mediaId, _version, operationId) => {
      await new IdentityAuditStore(prisma).followUp(operationId!, mediaId, { status: 'completed' });
      return {};
    });
    await service.apply(p.token!, 'admin');
    expect(await service.operation(p.token!)).toMatchObject({
      status: 'applied',
      receipt: { followUp: 'completed' },
    });
  });
  it('records a queued operation before dispatch and reports enqueue failure durably', async () => {
    const { service, hydration } = make();
    const p = await service.preview({ mediaId: 'source' }, 'admin');
    hydration.enqueueIdentityApply.mockRejectedValue(new Error('queue down'));
    await expect(service.enqueueApply(p.token!, 'admin')).rejects.toThrow('queue down');
    expect(await service.operation(p.token!)).toMatchObject({ status: 'failed' });
  });
});
