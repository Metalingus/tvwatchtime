import { PrismaClient, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { fenceIdentityWrite } from './util/identity-write-fence';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { IdentityAuditStore } from './identity-audit.store';
import { TrackingService } from '../tracking/tracking.service';

const url = process.env.WATCHFORGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
suite('Identity write fences — independent PostgreSQL connections', () => {
  let db: PrismaClient;
  const fixtures: Array<{ userId: string; mediaIds: string[] }> = [];
  beforeAll(() => {
    if (!['localhost', '127.0.0.1'].includes(new URL(url!).hostname))
      throw new Error('Local dev database required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      await db.user.delete({ where: { id: fixture.userId } });
      await db.mediaItem.deleteMany({ where: { id: { in: fixture.mediaIds } } });
    }
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function seed() {
    const key = 'identity-race-' + randomUUID();
    const fixture = { userId: '', mediaIds: [] as string[] };
    fixtures.push(fixture);
    const user = await db.user.create({
      data: { email: key + '@identity.invalid', username: key },
    });
    fixture.userId = user.id;
    const source = await db.mediaItem.create({
      data: { type: 'MOVIE', title: key + ' source', movie: { create: { releaseYear: 2000 } } },
    });
    fixture.mediaIds.push(source.id);
    const target = await db.mediaItem.create({
      data: { type: 'MOVIE', title: key + ' target', movie: { create: { releaseYear: 2000 } } },
    });
    fixture.mediaIds.push(target.id);
    const ids = [
      { provider: 'THE_TVDB' as const, providerEntityKind: 'MOVIE' as const, value: key + 'tvdb' },
      { provider: 'TMDB' as const, providerEntityKind: 'MOVIE' as const, value: key + 'tmdb' },
    ];
    await db.externalId.create({ data: { ...ids[0], mediaId: source.id } });
    await db.externalId.create({ data: { ...ids[1], mediaId: target.id } });
    return { user, source, target, ids };
  }
  it('rolls back the copy and audit receipt together, then commits them together on retry', async () => {
    const { user, source, target, ids } = await seed(),
      token = randomUUID();
    const store = new IdentityAuditStore(db as any);
    await store.savePlan(
      token,
      user.id,
      { mediaId: source.id },
      { status: 'ready', fingerprint: 'fixture' },
    );
    await db.favorite.create({ data: { userId: user.id, mediaId: source.id } });
    const canonical = new MediaCanonicalizationService(
      db as any,
      {} as any,
      redis as any,
      { emit: () => {} } as any,
    );
    try {
      await canonical
        .identityFamily([source.id, target.id], target.id, {
          mode: 'repair',
          verifiedIds: ids,
          commit: async (tx) => {
            await store.committed(tx, token, { mediaIds: [target.id] });
            throw Error('fixture commit failure');
          },
        })
        .catch(() => undefined);
      expect(await db.favorite.count({ where: { mediaId: target.id, userId: user.id } })).toBe(0);
      expect(
        await db.mediaCanonicalLink.count({
          where: { sourceMediaId: source.id, status: 'ACTIVE' },
        }),
      ).toBe(0);
      expect((await store.operation(token)).status).toBe('ready');
      const result = await canonical.identityFamily([source.id, target.id], target.id, {
        mode: 'repair',
        verifiedIds: ids,
        commit: (tx) => store.committed(tx, token, { mediaIds: [target.id] }),
      });
      expect(result.status).toBe('applied');
      expect((await store.publicOperation(token)).status).toBe('applied');
      expect(await db.favorite.count({ where: { mediaId: target.id, userId: user.id } })).toBe(1);
    } finally {
      await db.adminAuditLog.delete({ where: { id: token } });
    }
  });

  async function blocked(pid: number) {
    for (let i = 0; i < 100; i++) {
      const [row] = await db.$queryRaw<
        Array<{ n: number }>
      >`SELECT cardinality(pg_blocking_pids(${pid}::int))::int AS n`;
      if (row.n > 0) return;
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error('Expected database lock wait did not occur');
  }
  const redis = {
    del: async () => {},
    delByPattern: async () => 0,
    client: { incr: async () => 1 },
  };
  it('waits for an in-flight watch and includes it in the canonical copy', async () => {
    const { user, source, target, ids } = await seed();
    const writerReady = signal(),
      releaseWriter = signal(),
      repairPid = signal<number>();
    const writer = db.$transaction(
      async (tx) => {
        await fenceIdentityWrite(tx, { mediaIds: [source.id], type: 'MOVIE', userId: user.id });
        await tx.userMovieStatus.create({
          data: { userId: user.id, mediaId: source.id, watched: true },
        });
        writerReady.resolve();
        await releaseWriter.promise;
      },
      { timeout: 15000 },
    );
    await writerReady.promise;
    const client = new Proxy(db, {
      get: (obj, key) =>
        key === '$transaction'
          ? async (fn: any, opts: any) =>
              db.$transaction(async (tx) => {
                const [row] = await tx.$queryRaw<
                  Array<{ pid: number }>
                >`SELECT pg_backend_pid() AS pid`;
                repairPid.resolve(row.pid);
                return fn(tx);
              }, opts)
          : (obj as any)[key],
    });
    const canonical = new MediaCanonicalizationService(
      client as any,
      {} as any,
      redis as any,
      { emit: () => {} } as any,
    );
    const repair = canonical.identityFamily([source.id, target.id], target.id, {
      mode: 'repair',
      verifiedIds: ids,
    });
    let result;
    try {
      await blocked(await repairPid.promise);
    } finally {
      releaseWriter.resolve();
      await writer;
      result = await repair;
    }
    expect(result).toMatchObject({ status: 'applied' });
    expect(
      await db.userMovieStatus.findFirst({ where: { userId: user.id, mediaId: target.id } }),
    ).toMatchObject({ watched: true });
  }, 20000);

  it('rejects a stale write after waiting behind cutover instead of stranding it on the source', async () => {
    const { user, source, target } = await seed();
    const cutoverReady = signal(),
      releaseCutover = signal(),
      writerPid = signal<number>();
    const cutover = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM media_items WHERE id=${source.id} FOR UPDATE`;
        cutoverReady.resolve();
        await releaseCutover.promise;
        await tx.mediaCanonicalLink.create({
          data: {
            sourceMediaId: source.id,
            targetMediaId: target.id,
            relation: 'EXACT_DUPLICATE',
            status: 'ACTIVE',
          },
        });
        await tx.mediaItem.update({ where: { id: source.id }, data: { updatedAt: new Date() } });
      },
      { timeout: 15000 },
    );
    await cutoverReady.promise;
    const writer = db
      .$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          writerPid.resolve(row.pid);
          await fenceIdentityWrite(tx, { mediaIds: [source.id], type: 'MOVIE' });
          await tx.favorite.create({ data: { userId: user.id, mediaId: source.id } });
        },
        { timeout: 15000 },
      )
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    try {
      await blocked(await writerPid.promise);
    } finally {
      releaseCutover.resolve();
      await cutover;
      await writer;
    }
    expect((await writer).error?.getStatus()).toBe(409);
    expect(await db.favorite.count({ where: { userId: user.id } })).toBe(0);
  }, 20000);

  it('rejects an old repeatable-read snapshot after source retirement', async () => {
    const { source, target } = await seed();
    const readReady = signal(),
      continueWrite = signal();
    const writer = db
      .$transaction(
        async (tx) => {
          await tx.mediaItem.findUnique({ where: { id: source.id } });
          readReady.resolve();
          await continueWrite.promise;
          await fenceIdentityWrite(tx, { mediaIds: [source.id] });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 },
      )
      .then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    await readReady.promise;
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM media_items WHERE id=${source.id} FOR UPDATE`;
        await tx.mediaCanonicalLink.create({
          data: {
            sourceMediaId: source.id,
            targetMediaId: target.id,
            relation: 'EXACT_DUPLICATE',
            status: 'ACTIVE',
          },
        });
        await tx.mediaItem.update({ where: { id: source.id }, data: { updatedAt: new Date() } });
      });
    } finally {
      continueWrite.resolve();
    }
    expect((await writer).error).toBeTruthy();
  }, 20000);

  it('concurrent repeated movie-watch requests produce one first-watch history row', async () => {
    const { user, source } = await seed();
    const tracking = new TrackingService(db as any, { emit: () => {} } as any, redis as any);
    await Promise.all([
      tracking.markMovieWatched(user.id, source.id, {}),
      tracking.markMovieWatched(user.id, source.id, {}),
    ]);
    expect(await db.watchHistory.count({ where: { userId: user.id, mediaId: source.id } })).toBe(1);
    expect(
      await db.userMovieStatus.findFirst({ where: { userId: user.id, mediaId: source.id } }),
    ).toMatchObject({ watched: true, watchCount: 1 });
  }, 20000);
});
