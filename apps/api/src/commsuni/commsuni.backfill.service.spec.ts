import { CommsUniBackfillService } from './commsuni.backfill.service';
const runId = '11111111-1111-4111-8111-111111111111';
const cutoff = '2026-01-02T00:00:00Z';
function setup() {
  const row: any = {
    id: 'comment',
    userId: 'user',
    threadType: 'MOVIE',
    threadId: 'movie',
    source: 'MANUAL',
    sourceKey: null,
    createdAt: new Date('2026-01-01'),
    parentId: null,
    body: 'Original',
    isSpoiler: false,
    image: null,
    user: { id: 'user', username: 'Name', isShadow: false, isSuspended: false, profile: null },
  };
  const operations = new Map<string, any>();
  const db: any = {
    mediaCanonicalCopy: { findFirst: jest.fn().mockResolvedValue(null) },
    comment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn(async () => [row]),
      findUnique: jest.fn(async ({ where }) => (where.id === row.id ? row : null)),
      groupBy: jest.fn().mockResolvedValue([{ source: 'MANUAL', _count: { _all: 1 } }]),
    },
    importAppliedRecord: { findFirst: jest.fn().mockResolvedValue(null) },
    commsUniOutbox: {
      findUnique: jest.fn(async ({ where }) => operations.get(where.dedupeKey) ?? null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  db.$transaction = jest.fn(async (fn) => fn(db));
  const values: Record<string, unknown> = {
    'commsuni.actorSecret': 'test-secret-for-backfill-only-1234567890',
    'commsuni.backfillEnabled': true,
  };
  const client: any = {
    enabled: true,
    writesEnabled: true,
    scope: 'scope',
    sourceSlug: 'tvwatch',
    assertWrites: jest.fn(() => {
      if (!client.writesEnabled) throw Error('writes disabled');
    }),
    writePausedUntil: jest.fn().mockResolvedValue(null),
  };
  const target: any = {
    threadType: 'MOVIE',
    threadId: 'movie',
    fingerprint: 'mapping',
    reference: 'tvdb-369369',
    entityId: null,
  };
  const resolver: any = { resolve: jest.fn(async () => target) };
  const publication: any = {
    commentBody: jest.fn((comment) => ({
      text: comment.body,
      createdAt: comment.createdAt.toISOString(),
      isSpoiler: comment.isSpoiler,
    })),
    capture: jest.fn(async (_tx, _user, comment) => {
      operations.set('comment:' + comment.id, {
        id: 'operation',
        state: 'PENDING',
        identity: { scope: 'scope' },
      });
    }),
  };
  const service = new CommsUniBackfillService(
    db,
    { get: (key: string) => values[key] } as any,
    client,
    resolver,
    publication,
  );
  jest.spyOn(service, 'readiness').mockResolvedValue({
    images: {
      deliveryUrlExample: null,
      configuredHostAllowed: false,
      operatorRegistrationVerified: false,
    },
    missing: [],
    connectionScope: 'scope',
    writesEnabled: true,
    writePausedUntil: 0,
    backfillEnabled: true,
    automaticModerationConfigured: true,
  });
  const preview = () => service.preview({ runId, cutoff });
  const apply = (proof: string) =>
    service.enqueue({
      runId,
      cutoff,
      acknowledgeHistoricalSharing: true,
      entries: [{ commentId: row.id, proof }],
    });
  return {
    service,
    db,
    row,
    client,
    values,
    target,
    resolver,
    publication,
    operations,
    preview,
    apply,
  };
}

describe('reviewed CommsUni backfill (isolated database and provider mocks)', () => {
  it('previews without mutating the database or enqueuing anything, even with writes off', async () => {
    const f = setup();
    f.client.writesEnabled = false;
    const page = await f.preview();
    expect(page.rows[0]).toMatchObject({
      status: 'eligible',
      payload: { text: 'Original', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(f.resolver.resolve).toHaveBeenCalledWith('user', 'MOVIE', 'movie', { persist: false });
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.publication.capture).not.toHaveBeenCalled();
  });
  it.each([
    { source: 'TVTIME' },
    { source: 'TRAKT' },
    { source: null },
    { sourceKey: 'imported' },
    { commsUniOriginId: 'original-copy' },
    { hidden: true },
    { threadType: 'GROUP' },
    { externalReviewId: 'review' },
    { mediaId: 'card' },
    { listId: 'list' },
    { commsUniCommentId: runId },
    { user: { isShadow: true } },
  ])('never exports ineligible data: %j', async (change) => {
    const f = setup();
    Object.assign(f.row, change);
    expect((await f.preview()).rows[0].status).toBe('excluded');
    expect(f.resolver.resolve).not.toHaveBeenCalled();
  });
  it('uses import audit evidence even if a comment was later tagged MANUAL', async () => {
    const f = setup();
    f.db.importAppliedRecord.findFirst.mockResolvedValue({ id: 'audit' });
    expect((await f.preview()).rows[0].reason).toBe('import_audit_record');
    expect(f.publication.capture).not.toHaveBeenCalled();
  });
  it.each(['body', 'userId', 'threadId'])('rejects a changed %s after review', async (field) => {
    const f = setup();
    const page = await f.preview();
    f.row[field] = 'changed';
    expect((await f.apply(page.rows[0].proof!)).results[0].status).toBe('blocked');
    expect(f.publication.capture).not.toHaveBeenCalled();
  });
  it('rejects a changed provider mapping even with unchanged local IDs', async () => {
    const f = setup();
    const page = await f.preview();
    f.target.reference = 'tvdb-999';
    expect((await f.apply(page.rows[0].proof!)).results[0].reason).toBe('preview_changed');
    expect(f.publication.capture).not.toHaveBeenCalled();
  });
  it('captures once with the original run and permanent local dedupe key', async () => {
    const f = setup();
    const page = await f.preview();
    expect((await f.apply(page.rows[0].proof!)).results[0].status).toBe('queued');
    expect((await f.apply(page.rows[0].proof!)).results[0].status).toBe('existing');
    expect(f.publication.capture).toHaveBeenCalledTimes(1);
    expect(f.publication.capture.mock.calls[0].slice(3)).toEqual([
      false,
      undefined,
      { runId, cutoff },
      f.target,
    ]);
  });
  it('defers admission when the bounded historical queue is full', async () => {
    const f = setup();
    const page = await f.preview();
    f.db.commsUniOutbox.count.mockResolvedValue(100);
    expect((await f.apply(page.rows[0].proof!)).results[0]).toMatchObject({
      status: 'deferred',
      reason: 'backfill_queue_full',
    });
    expect(f.publication.capture).not.toHaveBeenCalled();
  });
  it.each(['writes', 'backfill', 'budget', 'schema'])(
    'stops before admission when %s is unavailable',
    async (gate) => {
      const f = setup();
      const page = await f.preview();
      if (gate === 'writes') f.client.writesEnabled = false;
      if (gate === 'backfill') f.values['commsuni.backfillEnabled'] = false;
      if (gate === 'budget') f.client.writePausedUntil.mockResolvedValue(Date.now() + 60000);
      if (gate === 'schema')
        jest.spyOn(f.service, 'readiness').mockResolvedValue({ missing: ['migration'] } as any);
      await expect(f.apply(page.rows[0].proof!)).rejects.toThrow();
      expect(f.publication.capture).not.toHaveBeenCalled();
    },
  );
  it('accepts an already queued native parent and references an imported UUID without exporting it', async () => {
    for (const parent of [
      { source: 'MANUAL', commsUniState: 'PENDING' },
      { source: 'TVTIME', sourceKey: 'tvtime|' + runId },
    ]) {
      const f = setup();
      f.row.parentId = 'parent';
      f.db.comment.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === 'parent' ? { ...f.row, ...parent, id: 'parent', parentId: null } : f.row,
      );
      const page = await f.preview();
      expect(page.rows[0].status).toBe('eligible');
      expect((await f.apply(page.rows[0].proof!)).results[0].status).toBe('queued');
      expect(f.publication.capture.mock.calls[0][2].id).toBe('comment');
    }
  });
  it('requires a parent to be queued first and stops replies whose timestamps precede it', async () => {
    const f = setup();
    f.row.parentId = 'parent';
    const parent = { ...f.row, id: 'parent', parentId: null };
    f.db.comment.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === 'parent' ? parent : f.row,
    );
    const page = await f.preview();
    expect((await f.apply(page.rows[0].proof!)).results[0].reason).toBe('enqueue_parent_first');
    parent.createdAt = new Date('2026-01-01T00:00:01Z');
    expect((await f.preview()).rows[0].reason).toBe('reply_precedes_parent');
  });
  it('exports every mapping through a sequence cursor without serializing BigInt', async () => {
    const f = setup();
    f.db.commsUniOutbox.findMany.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: String(i),
        sequence: BigInt(i + 1),
        target: {},
      })),
    );
    const report = await f.service.report(runId);
    expect(report.operations).toHaveLength(100);
    expect(report.nextCursor).toBe('100');
    expect(() => JSON.stringify(report)).not.toThrow();
    await f.service.report(runId, report.nextCursor!);
    expect(f.db.commsUniOutbox.findMany.mock.calls[1][0].where.sequence).toEqual({ gt: 100n });
  });
});

it.each(['ledger', 'timestamp'])('holds old structural copies with %s evidence', async (mode) => {
  const f = setup();
  if (mode === 'ledger') f.db.mediaCanonicalCopy.findFirst.mockResolvedValue({ id: 'copy' });
  else f.db.comment.findFirst.mockResolvedValue({ id: 'possible-copy' });
  expect((await f.preview()).rows[0].reason).toBe(
    mode === 'ledger' ? 'structural_copy_ledger' : 'ambiguous_cross_thread_origin',
  );
  expect(f.publication.capture).not.toHaveBeenCalled();
});
