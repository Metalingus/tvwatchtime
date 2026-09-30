// This HTTP compatibility fixture isolates payloads; PostgreSQL fence races have a separate suite.
jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ValidationPipe } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { COMMSUNI_CLIENT_HEADER, COMMSUNI_CLIENT_VERSION } from '@tvwatch/shared';
import { ClientCapabilitiesInterceptor } from '../common/client-capabilities';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureFlagService } from '../common/feature-flag.service';
import { CapabilityService } from '../common/capability.service';
import { CommentImageController } from '../comment-images/comment-image.controller';
import { CommentImageService } from '../comment-images/comment-image.service';
import { encryptImage } from '../comment-images/lib/crypto';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import { unseal } from '../commsuni/commsuni.crypto';
import { CommentsService } from './comments.service';
import { SocialController } from './social.controller';
import { SocialService } from './social.service';
import { ModerationService } from './moderation.service';
import { TranslationService } from './translation.service';

const remoteId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';
const secret = 'compat-test-secret-not-a-real-key-123456';
const imageKey = 'compat-image-key'.padEnd(32, 'x');
const gifBytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function matches(row: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([key, value]: [string, any]) => {
    if (key === 'OR') return value.some((part: any) => matches(row, part));
    if (key === 'AND') return value.every((part: any) => matches(row, part));
    const actual = row[key] ?? null;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      if ('in' in value) return value.in.includes(actual);
      if ('notIn' in value) return !value.notIn.includes(actual);
      if ('not' in value) return actual !== value.not;
    }
    return value instanceof Date ? +actual === +value : actual === value;
  });
}
function fixture() {
  const comments = new Map<string, any>();
  const images = new Map<string, any>();
  const operations = new Map<string, any>();
  const likes = new Map<string, any>();
  const files = new Map<string, Buffer>();
  const user = {
    id: 'u1',
    username: 'alice',
    profile: null,
    createdAt: new Date('2024-01-01'),
    isShadow: false,
    isSuspended: false,
  };
  const hydrate = (row: any) =>
    row
      ? {
          ...row,
          user: { ...user, id: row.userId },
          image: [...images.values()].find((image) => image.commentId === row.id) ?? null,
        }
      : null;
  const update = (row: any, data: any) => {
    for (const [key, value] of Object.entries(data) as [string, any][]) {
      row[key] =
        value && typeof value === 'object' && 'increment' in value
          ? (row[key] ?? 0) + value.increment
          : value && typeof value === 'object' && 'decrement' in value
            ? (row[key] ?? 0) - value.decrement
            : value;
    }
    return row;
  };
  const find = (rows: Map<string, any>, where: any) =>
    [...rows.values()].find((row) => matches(row, where)) ?? null;
  const model = (rows: Map<string, any>, comment = false): any => ({
    findUnique: jest.fn(async ({ where }) =>
      comment ? hydrate(find(rows, where)) : find(rows, where),
    ),
    findFirst: jest.fn(async ({ where }) =>
      comment ? hydrate(find(rows, where)) : find(rows, where),
    ),
    findMany: jest.fn(async ({ where = {} } = {}) =>
      [...rows.values()]
        .filter((row) => matches(row, where))
        .map((row) => (comment ? hydrate(row) : row)),
    ),
    count: jest.fn(
      async ({ where = {} } = {}) => [...rows.values()].filter((row) => matches(row, where)).length,
    ),
    groupBy: jest.fn().mockResolvedValue([]),
    create: jest.fn(async ({ data }) => {
      const row = {
        id: data.id ?? randomUUID(),
        commentId: null,
        retainedCommentId: null,
        state: 'PENDING',
        firstAttemptAt: null,
        ...data,
      };
      rows.set(row.id, row);
      return comment ? hydrate(row) : row;
    }),
    update: jest.fn(async ({ where, data }) => {
      const row = find(rows, where);
      if (!row) throw Error('Missing fixture row');
      update(row, data);
      return comment ? hydrate(row) : row;
    }),
    updateMany: jest.fn(async ({ where, data }) => {
      const found = [...rows.values()].filter((row) => matches(row, where));
      found.forEach((row) => update(row, data));
      return { count: found.length };
    }),
    upsert: jest.fn(async ({ where, create, update: data }) => {
      const existing = find(rows, where);
      if (existing) return update(existing, data);
      const row = {
        id: create.id ?? randomUUID(),
        state: 'PENDING',
        firstAttemptAt: null,
        ...create,
      };
      rows.set(row.id, row);
      return row;
    }),
    deleteMany: jest.fn(async ({ where }) => {
      const found = [...rows.values()].filter((row) => matches(row, where));
      found.forEach((row) => rows.delete(row.id));
      return { count: found.length };
    }),
  });
  const db: any = {
    comment: model(comments, true),
    commentImage: model(images),
    commsUniOutbox: model(operations),
    user: { findUnique: jest.fn(async () => user) },
    mediaItem: {
      findUnique: jest.fn(async () => ({ id: 't1', type: 'SHOW', externalIds: [], show: {} })),
      findMany: jest.fn().mockResolvedValue([]),
    },
    episode: { findMany: jest.fn().mockResolvedValue([]) },
    block: { findMany: jest.fn().mockResolvedValue([]) },
    follow: { count: jest.fn().mockResolvedValue(0), groupBy: jest.fn().mockResolvedValue([]) },
    commsUniReport: { findMany: jest.fn().mockResolvedValue([]) },
    commentSpoilerReport: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  db.$transaction = jest.fn(async (action: any) => {
    const snapshots = [comments, images, operations].map(
      (rows) => new Map([...rows].map(([key, value]) => [key, structuredClone(value)])),
    );
    try {
      return Array.isArray(action) ? await Promise.all(action) : await action(db);
    } catch (error) {
      [comments, images, operations].forEach((rows, index) => {
        rows.clear();
        snapshots[index].forEach((value, key) => rows.set(key, value));
      });
      throw error;
    }
  });
  db.commentLike = {
    findMany: jest.fn(async ({ where }) =>
      [...likes.values()].filter((row) => matches(row, where)),
    ),
    create: jest.fn(async ({ data }) => {
      const key = data.userId + ':' + data.commentId;
      if (likes.has(key)) throw Error('duplicate');
      likes.set(key, data);
      return data;
    }),
    deleteMany: jest.fn(async ({ where }) => {
      const key = where.userId + ':' + where.commentId;
      return { count: Number(likes.delete(key)) };
    }),
  };
  db.commsUniIdentity = {
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(async ({ data }) => ({ id: 'identity', ...data })),
  };
  const config: any = {
    get: (key: string) =>
      (
        ({
          'commsuni.actorSecret': secret,
          'commsuni.mediaHosts': ['api.example.test'],
          'api.baseUrl': 'https://api.example.test',
          'commentImages.encryptionMasterKey': imageKey,
          'commentImages.maxUploadMb': 20,
          'commentImages.uploadsPerUserPerDay': 100,
        }) as any
      )[key],
  };
  const events: any = { emit: jest.fn() };
  const notifications: any = { createForUser: jest.fn().mockResolvedValue(undefined) };
  const storage: any = {
    putTemp: jest.fn().mockResolvedValue(undefined),
    deleteTemp: jest.fn().mockResolvedValue(undefined),
    getEncrypted: jest.fn(async (key: string) => files.get(key)),
    deleteObject: jest.fn().mockResolvedValue(undefined),
  };
  const imageService = new CommentImageService(db, storage, config, events);
  const client: any = {
    enabled: true,
    writesEnabled: true,
    scope: 'scope',
    sourceSlug: 'tv-watch-time',
    actor: () => 'a'.repeat(64),
    request: jest.fn(),
  };
  const resolver: any = {
    canonicalThread: jest.fn(async (_type, id) => id),
    resolve: jest.fn(async (_user, threadType, threadId) => ({
      threadType,
      threadId,
      entityId,
      entityType: 'show',
    })),
  };
  const reads: any = {
    blockedIdentities: jest.fn(async () => ({ userIds: new Set(), authorIds: new Set() })),
    comment: jest.fn(async () => ({
      id: remoteId,
      entityId,
      author: { id: remoteId },
      createdAt: '2020-01-01T00:00:00Z',
      actions: { reply: true },
    })),
    commentsByIds: jest.fn().mockResolvedValue([]),
  };
  const publication = new CommsUniPublicationService(
    db,
    config,
    {} as any,
    client,
    resolver,
    reads,
  );
  const service = new CommentsService(db, events, notifications, imageService);
  const moderateText = jest
    .fn()
    .mockResolvedValue({ decision: 'allow', flagged: false, model: 'test' });
  Object.assign(service, {
    publication,
    conversationResolver: resolver,
    sharedReads: reads,
    contentModeration: { enabled: true, moderateText },
  });
  const addComment = (over: any = {}) => {
    const row = {
      id: 'c1',
      userId: 'u1',
      body: 'Original',
      threadType: 'SHOW',
      threadId: 't1',
      source: 'MANUAL',
      parentId: null,
      rootId: null,
      depth: 0,
      imageUrl: null,
      gifUrl: null,
      createdAt: new Date('2020-01-01'),
      commsUniState: null,
      commsUniCommentId: null,
      commsUniEntityId: null,
      hasLocalRevision: false,
      hidden: false,
      adminDeleted: false,
      deletedByUser: false,
      likesCount: 7,
      repliesCount: 2,
      ...over,
    };
    comments.set(row.id, row);
    return row;
  };
  const addSharedImage = (commentId: string) => {
    const encrypted = encryptImage(gifBytes, Buffer.from(imageKey).toString('hex').slice(0, 64));
    const image = {
      id: 'original-image',
      commentId,
      retainedCommentId: commentId,
      userId: 'u1',
      status: 'ready',
      storageKey: 'original.gif.enc',
      ...encrypted,
    };
    images.set(image.id, image);
    files.set(image.storageKey, encrypted.ciphertext);
    return image;
  };
  return {
    db,
    service,
    imageService,
    client,
    publication,
    resolver,
    moderateText,
    storage,
    operations,
    comments,
    images,
    notifications,
    addComment,
    addSharedImage,
  };
}

describe('old/new mobile HTTP compatibility with provider writes enabled', () => {
  let f: ReturnType<typeof fixture>;
  let app: any;
  let baseUrl: string;
  async function http(
    method: string,
    path: string,
    expected: number,
    options: {
      body?: unknown;
      modern?: boolean;
      file?: boolean;
    } = {},
  ) {
    const headers: Record<string, string> = options.modern
      ? { [COMMSUNI_CLIENT_HEADER]: COMMSUNI_CLIENT_VERSION }
      : {};
    let body: string | FormData | undefined;
    if (options.file) {
      const data = new FormData();
      data.append('file', new Blob([gifBytes], { type: 'image/gif' }), 'image.gif');
      body = data;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await fetch(baseUrl + path, { method, headers, body });
    const data = response.headers.get('content-type')?.includes('application/json')
      ? await response.json()
      : Buffer.from(await response.arrayBuffer());
    expect({ status: response.status, error: response.ok ? undefined : data }).toEqual({
      status: expected,
      error: response.ok ? undefined : expect.anything(),
    });
    return { body: data as any, response };
  }
  beforeEach(async () => {
    f = fixture();
    const module = await Test.createTestingModule({
      controllers: [SocialController, CommentImageController],
      providers: [
        { provide: CommentsService, useValue: f.service },
        { provide: CommentImageService, useValue: f.imageService },
        { provide: SocialService, useValue: {} },
        { provide: ModerationService, useValue: {} },
        { provide: TranslationService, useValue: {} },
        { provide: FeatureFlagService, useValue: { isEnabled: async () => true } },
        { provide: CapabilityService, useValue: { commentImages: true } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: any) => {
          context.switchToHttp().getRequest().user = { id: 'u1' };
          return true;
        },
      })
      .compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.useGlobalInterceptors(new ClientCapabilitiesInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()) + '/api';
  });
  afterEach(async () => app.close());

  it('accepts the old create-then-upload payload without publishing prematurely', async () => {
    const created = await http('POST', '/comments', 201, {
      body: { threadType: 'SHOW', threadId: 't1', body: 'Photo caption' },
    });
    expect(created.body.commsUniState).toBeNull();
    expect(f.operations.size).toBe(0);
    const uploaded = await http('POST', '/comments/' + created.body.id + '/image', 201, {
      file: true,
    });
    expect(uploaded.body.commentImageId).toBeTruthy();
    expect(f.moderateText).toHaveBeenCalledWith('Photo caption');
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.operations.size).toBe(0);
  });

  it('opts new clients into the pending-attachment protocol and pins the finalized image', async () => {
    const created = await http('POST', '/comments', 201, {
      modern: true,
      body: { threadType: 'SHOW', threadId: 't1', body: 'New photo', attachmentPending: true },
    });
    expect(created.body.commsUniState).toBe('WAITING_ATTACHMENT');
    const uploaded = await http('POST', '/comments/' + created.body.id + '/image', 201, {
      modern: true,
      file: true,
    });
    const image = f.images.get(uploaded.body.commentImageId)!;
    Object.assign(image, { status: 'ready', storageKey: 'new.gif.enc' });
    await f.publication.finalize('u1', created.body.id);
    expect(image.retainedCommentId).toBe(created.body.id);
    const operation = [...f.operations.values()][0];
    expect(operation.state).toBe('PENDING');
    expect(unseal<any>(secret, operation.payload).attachments[0].url).toContain(image.id);
  });

  it.each([false, true])(
    'keeps edits and replacement images local for modern=%s',
    async (modern) => {
      const original = f.addComment();
      const image = f.addSharedImage(original.id);
      image.retainedCommentId = null as any;
      await f.publication.capture(
        f.db,
        'u1',
        await f.db.comment.findUnique({ where: { id: original.id } }),
        false,
      );
      const operation = [...f.operations.values()][0];
      const originalPayload = operation.payload;
      Object.assign(original, {
        commsUniState: 'SYNCED',
        commsUniCommentId: remoteId,
        commsUniEntityId: entityId,
      });
      Object.assign(operation, { state: 'SYNCED', remoteId, firstAttemptAt: new Date() });
      expect(image.retainedCommentId).toBe(original.id);
      const edited = await http('PATCH', '/comments/c1', 200, {
        modern,
        body: { body: 'Edited locally', detachImage: true },
      });
      expect(edited.body).toMatchObject({
        id: 'c1',
        body: 'Edited locally',
        hasLocalRevision: true,
        likesCount: 7,
        repliesCount: 2,
      });
      expect(edited.body.image).toBeNull();
      expect(image.commentId).toBeNull();
      expect(image.retainedCommentId).toBe('c1');
      expect(f.storage.deleteObject).not.toHaveBeenCalled();
      expect(operation.payload).toBe(originalPayload);
      expect(unseal<any>(secret, operation.payload).text).toBe('Original');
      const served = await http('GET', '/comment-images/original-image', 200);
      expect(served.response.headers.get('content-type')).toContain('image/gif');
      expect(served.body).toEqual(gifBytes);
      const replacement = await http('POST', '/comments/c1/image', 201, { modern, file: true });
      expect(replacement.body.commentImageId).not.toBe(image.id);
      expect(f.images.get(replacement.body.commentImageId)?.retainedCommentId).toBeNull();
      expect(f.client.request).not.toHaveBeenCalled();
      await http('DELETE', '/comments/c1', 200);
      expect(original.deletedByUser).toBe(true);
      expect([...f.operations.values()].find((row) => row.method === 'DELETE')).toMatchObject({
        path: '/comments/' + remoteId,
        cleanup: true,
      });
      await http('GET', '/comment-images/original-image', 404);
    },
  );

  it('preserves moderation and ownership checks for legacy edits', async () => {
    const original = f.addComment({ commsUniState: 'SYNCED', commsUniCommentId: remoteId });
    f.addSharedImage(original.id);
    f.moderateText.mockResolvedValue({ decision: 'reject', flagged: true });
    await http('PATCH', '/comments/c1', 400, { body: { body: 'Rejected', detachImage: true } });
    expect(original.body).toBe('Original');
    expect(f.images.get('original-image')?.commentId).toBe('c1');
    original.userId = 'another-user';
    await http('PATCH', '/comments/c1', 403, { body: { body: 'Not mine' } });
  });

  it('lets updated clients edit their shared comment locally without republishing it', async () => {
    const original = f.addComment({ commsUniState: 'SYNCED', commsUniCommentId: remoteId });
    const edited = await http('PATCH', '/comments/c1', 200, {
      modern: true,
      body: { body: 'Edited in TV Watch Time' },
    });
    expect(edited.body).toMatchObject({ body: 'Edited in TV Watch Time', hasLocalRevision: true });
    expect(original.commsUniCommentId).toBe(remoteId);
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it('keeps legacy likes local even when the comment has been backfilled', async () => {
    const original = f.addComment({ commsUniState: 'SYNCED', commsUniCommentId: remoteId });
    await http('POST', '/comments/c1/like', 201, { body: {} });
    expect(original.likesCount).toBe(8);
    expect(f.client.request).not.toHaveBeenCalled();
    expect(f.operations.size).toBe(0);
    await http('DELETE', '/comments/c1/like', 200);
    expect(original.likesCount).toBe(7);
  });

  it('maps new shared replies into the existing local thread and keeps retry identity', async () => {
    f.addComment({
      userId: 'u2',
      commsUniState: 'SYNCED',
      commsUniCommentId: remoteId,
      commsUniEntityId: entityId,
    });
    const body = {
      threadType: 'SHOW',
      threadId: 't1',
      body: 'Reply',
      commsUniParentId: remoteId,
      clientActionId: randomUUID(),
    };
    const first = await http('POST', '/comments', 201, { modern: true, body });
    const retry = await http('POST', '/comments', 201, { modern: true, body });
    expect(first.body.parentId).toBe('c1');
    expect(retry.body.id).toBe(first.body.id);
    expect(f.comments.get(first.body.id)?.commsUniParentId).toBe(remoteId);
    expect(f.notifications.createForUser).toHaveBeenCalledTimes(1);
  });
  it('replays the original create request after a legacy edit without accepting a different action', async () => {
    const body = {
      threadType: 'SHOW',
      threadId: 't1',
      body: 'Original post',
      clientActionId: randomUUID(),
    };
    const first = await http('POST', '/comments', 201, { modern: true, body });
    const operation = [...f.operations.values()][0];
    const snapshot = operation.payload;
    await http('PATCH', '/comments/' + first.body.id, 200, { body: { body: 'Local edit' } });
    const replay = await http('POST', '/comments', 201, { modern: true, body });
    expect(replay.body).toMatchObject({
      id: first.body.id,
      body: 'Local edit',
      hasLocalRevision: true,
    });
    expect(f.operations.size).toBe(1);
    expect(operation.payload).toBe(snapshot);
    await http('POST', '/comments', 400, {
      modern: true,
      body: { ...body, body: 'Different create' },
    });
  });

  it('keeps an edited unfinished shared photo draft local when finalization runs later', async () => {
    const created = await http('POST', '/comments', 201, {
      modern: true,
      body: { threadType: 'SHOW', threadId: 't1', body: 'Original draft', attachmentPending: true },
    });
    await http('PATCH', '/comments/' + created.body.id, 200, { body: { body: 'Local revision' } });
    await f.publication.finalize('u1', created.body.id);
    expect([...f.operations.values()][0].state).toBe('CANCELED');
    expect(f.comments.get(created.body.id)).toMatchObject({
      body: 'Local revision',
      hasLocalRevision: true,
      commsUniState: 'CANCELED',
    });
    expect(f.client.request).not.toHaveBeenCalled();
  });

  it('preserves the existing local parent/thread identifiers for legacy requests', async () => {
    f.addComment({ userId: 'u2' });
    f.resolver.canonicalThread.mockResolvedValue('another-canonical-id');
    const created = await http('POST', '/comments', 201, {
      body: { threadType: 'SHOW', threadId: 't1', parentId: 'c1', body: 'Local reply' },
    });
    expect(created.body).toMatchObject({ parentId: 'c1', threadId: 't1', commsUniState: null });
    expect(f.resolver.canonicalThread).toHaveBeenCalledWith('SHOW', 't1');
  });
});
