import { CommsUniClient, CommsUniError } from './commsuni.client';
import { CommsUniExceptionFilter } from './commsuni.exception-filter';
import { decodeComment, decodeEngagement, tvtimeUuid } from './commsuni.read.service';
import { validateWrite } from './commsuni.validation';
import { CommsUniPublicationService } from './commsuni.publication.service';

const entity = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const author = '33333333-3333-4333-8333-333333333333';
const actor = 'a'.repeat(64);
const raw = () => ({
  id,
  entityId: entity,
  text: 'Original',
  createdAt: null,
  userId: author,
  userName: 'Persona',
  origin: { kind: 'partner', slug: 'other', displayName: 'Other' },
  rootCommentId: id,
  depth: 0,
  likeCount: 3,
  replyCount: 2,
  media: null,
  rating: null,
  viewerLiked: true,
});

function setup(writes: unknown = false) {
  const values: Record<string, unknown> = {
    nodeEnv: 'test',
    'commsuni.enabled': true,
    'commsuni.writesEnabled': writes,
    'commsuni.apiKey': 'fake-unit-test-key',
    'commsuni.actorSecret': 'x'.repeat(40),
    'commsuni.sourceSlug': 'tvwatch',
  };
  const entries = new Map<string, unknown>();
  const config = { get: jest.fn((key: string) => values[key]) };
  const redis = {
    client: {
      incr: jest.fn(async (key: string) => {
        const value = Number(entries.get(key) ?? 0) + 1;
        entries.set(key, value);
        return value;
      }),
    },
    get: jest.fn(async (key: string) => entries.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => {
      entries.set(key, value);
    }),
    delByPattern: jest.fn().mockResolvedValue(0),
  };
  return {
    client: new CommsUniClient(config as any, redis as any, global.fetch),
    config,
    redis,
    values,
  };
}

describe('CommsUni production write boundary', () => {
  const originalFetch = global.fetch;
  let network: jest.Mock;
  beforeEach(() => {
    network = jest.fn();
    global.fetch = network;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it.each([
    ['POST', '/entities/show/tvdb-1/comments'],
    ['POST', '/comments/' + id + '/replies'],
    ['PUT', '/authors/me/profile'],
    ['DELETE', '/authors/me/profile'],
    ['PUT', '/comments/' + id + '/like'],
    ['DELETE', '/comments/' + id + '/like'],
    ['PUT', '/comments/' + id + '/spoiler'],
    ['PATCH', '/comments/' + id],
    ['POST', '/comments/' + id + '/reports'],
    ['DELETE', '/comments/' + id],
    ['PUT', '/entities/movie/tvdb-1/rating'],
    ['DELETE', '/entities/episode/tvdb-1-s1e1/engagement/cast_vote'],
  ])('blocks %s %s before any network activity', async (method, path) => {
    const { client } = setup();
    await expect(client.request(actor, method, path, {}, {}, 'action')).rejects.toThrow(
      'writes are disabled',
    );
    expect(network).not.toHaveBeenCalled();
  });

  it.each([undefined, 'true', 'false', 1])(
    'fails closed for non-boolean configuration %s',
    async (value) => {
      const { client } = setup(value);
      await expect(client.request(actor, 'DELETE', '/comments/' + id)).rejects.toThrow();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it('isolates and coalesces actor-aware cache entries', async () => {
    const { client } = setup();
    network.mockImplementation(
      async (_url, options) =>
        new Response(JSON.stringify({ data: { actor: options.headers['X-TVTA-Actor-ID'] } }), {
          status: 200,
        }),
    );
    const [a, duplicate] = await Promise.all([
      client.read<any>('alice', '/sources'),
      client.read<any>('alice', '/sources'),
    ]);
    const b = await client.read<any>('bob', '/sources');
    await client.read('alice', '/sources');
    expect(network).toHaveBeenCalledTimes(2);
    expect(a).toEqual(duplicate);
    expect(a.actor).not.toEqual(b.actor);
    const headers = network.mock.calls[0][1].headers;
    expect(headers).not.toHaveProperty('Origin');
    expect(headers).not.toHaveProperty('Cookie');
    expect(headers.Authorization).toBe('Bearer fake-unit-test-key');
  });

  it('allows batch media reads with publishing off and caches only missing results', async () => {
    const { client } = setup();
    network.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { grants: [{ commentId: id, status: 'missing' }] },
        }),
        { status: 200 },
      ),
    );
    await client.mediaGrants('alice', [id]);
    await client.mediaGrants('alice', [id]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1].headers['X-TVTA-Actor-ID']).toBeTruthy();
    expect(network.mock.calls[0][1].redirect).toBe('manual');
  });
  it('invalidates the affected entity without evicting other entities or sources', async () => {
    const { client, redis } = setup();
    network.mockImplementation(
      async () =>
        new Response(JSON.stringify({ data: { marker: network.mock.calls.length } }), {
          status: 200,
        }),
    );
    await client.read('alice', '/sources');
    await client.read('alice', '/entities/show/tvdb-1/comments');
    await client.read('alice', '/entities/show/tvdb-2/comments');
    await client.invalidate(['entity:show:tvdb-1']);
    await client.read('alice', '/sources');
    await client.read('alice', '/entities/show/tvdb-2/comments');
    await client.read('alice', '/entities/show/tvdb-1/comments');
    expect(network).toHaveBeenCalledTimes(4);
    expect(redis.delByPattern).not.toHaveBeenCalled();
  });

  it('does not seed the active cache with a page that completed after invalidation', async () => {
    const { client } = setup();
    const resource = 'entity:show:tvdb-1';
    const epoch = await client.cacheVersion(resource);
    await client.invalidate([resource]);
    await client.prime('alice', '/comments/' + id, { comment: { text: 'old' } }, resource, epoch);
    network.mockResolvedValue(
      new Response(JSON.stringify({ data: { comment: { text: 'new' } } }), { status: 200 }),
    );
    const result = await client.read<any>('alice', '/comments/' + id, {}, 30, resource);
    expect(result.comment.text).toBe('new');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not follow signed-media redirects with provider credentials', async () => {
    const { client } = setup();
    network.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://media.example/image?signature=test' },
      }),
    );
    await expect(client.mediaUrl('alice', id)).resolves.toBe(
      'https://media.example/image?signature=test',
    );
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0][1].redirect).toBe('manual');
  });

  it('checks the gate again for a previously queued operation', async () => {
    const { client, config, redis } = setup();
    const prisma = { commsUniOutbox: { findUnique: jest.fn(), findMany: jest.fn() } };
    const service = new CommsUniPublicationService(
      prisma as any,
      config as any,
      redis as any,
      client,
      {} as any,
    );
    await service.onModuleInit();
    await service.drain();
    await service.dispatch('existing-operation');
    await service.capture(
      {} as any,
      'alice',
      { source: 'MANUAL', id: 'new-comment' } as any,
      false,
    );
    expect(prisma.commsUniOutbox.findUnique).not.toHaveBeenCalled();
    expect(prisma.commsUniOutbox.findMany).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('never publishes imported rows even when writes are explicitly enabled in a mock test', async () => {
    const { client, config, redis } = setup(true);
    const service = new CommsUniPublicationService(
      {} as any,
      config as any,
      redis as any,
      client,
      {} as any,
    );
    for (const source of ['TVTIME', 'TRAKT', null])
      await service.capture({} as any, 'alice', { source, sourceKey: 'import-key' } as any, false);
    expect(network).not.toHaveBeenCalled();
  });

  it.each([
    [false, false],
    [true, false],
    [true, true],
  ])(
    'accepts empty report acknowledgments (duplicate=%s, replay=%s)',
    async (duplicate, replayed) => {
      const { client } = setup(true);
      network.mockResolvedValue(
        new Response(null, {
          status: 202,
          headers: {
            'Report-Duplicate': String(duplicate),
            'Idempotency-Replayed': String(replayed),
          },
        }),
      );
      await expect(
        client.request(
          actor,
          'POST',
          '/comments/' + id + '/reports',
          {},
          { reason: 'spam' },
          'report-action',
        ),
      ).resolves.toEqual({ data: undefined, duplicateReport: duplicate, replayed });
      expect(network).toHaveBeenCalledTimes(1);
    },
  );

  it('still rejects an empty JSON response from a read endpoint', async () => {
    const { client } = setup();
    network.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(client.read('alice', '/sources')).rejects.toMatchObject({
      code: 'invalid_envelope',
    });
  });
  it('preserves write request identity when enabled against a fake fetch', async () => {
    const { client } = setup(true);
    network.mockResolvedValue(
      new Response(JSON.stringify({ data: { comment: raw() } }), { status: 201 }),
    );
    const body = { text: 'new', createdAt: '2026-01-01T12:00:00Z' };
    await client.request(
      actor,
      'POST',
      '/entities/show/tvdb-1/comments',
      {},
      body,
      'stable-action',
    );
    expect(network.mock.calls[0][1].headers['Idempotency-Key']).toBe('stable-action');
    expect(JSON.parse(network.mock.calls[0][1].body)).toEqual(body);
  });

  it('distinguishes a missing conversation from authentication failures', async () => {
    const { client } = setup();
    network.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'not_archived' } }), { status: 404 }),
    );
    await expect(client.read('alice', '/entities/show/tvdb-1/comments')).rejects.toMatchObject({
      empty: true,
    });
    network.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'insufficient_scope' } }), { status: 403 }),
    );
    await expect(client.read('alice', '/sources')).rejects.toMatchObject({ empty: false });
  });
});

describe('CommsUni identities and nullable responses', () => {
  it('rejects a valid comment UUID returned for the wrong media', () => {
    expect(() =>
      decodeComment(raw(), '44444444-4444-4444-8444-444444444444', new Map(), false, null),
    ).toThrow(CommsUniError);
  });
  it('keeps null dates/rating and absent viewer fields without invented defaults', () => {
    const input: any = raw();
    delete input.viewerLiked;
    const comment = decodeComment(input, entity, new Map(), false, null)!;
    expect(comment.createdAt).toBeNull();
    expect(comment.rating).toBeNull();
    expect(comment).not.toHaveProperty('viewerLiked');
    expect(comment.actions.like).toBe(false);
    expect(comment.actions.delete).toBe(false);
  });
  it('omits deleted content and strips signed URLs from archive image metadata', () => {
    expect(
      decodeComment({ ...raw(), deleted: true, replyCount: 0 }, entity, new Map(), false, null),
    ).toBeNull();
    const row = decodeComment(
      { ...raw(), media: { kind: 'archive', signedUrl: 'https://secret.example/signed' } },
      entity,
      new Map(),
      false,
      null,
    )!;
    expect(row.media).toEqual({ kind: 'archive' });
  });
  it('preserves actual reply target independently from the flattened parent', () => {
    const row = decodeComment(
      { ...raw(), parentCommentId: 'structural', inReplyToCommentId: 'actual', depth: 2 },
      entity,
      new Map(),
      false,
      null,
    )!;
    expect(row.parentCommentId).toBe('structural');
    expect(row.inReplyToCommentId).toBe('actual');
  });
  it('never treats generated import UUIDs or numeric legacy IDs as source UUIDs', () => {
    expect(tvtimeUuid('TVTIME', 'tvtime|' + id)).toBe(id);
    expect(tvtimeUuid('TVTIME', 'tvtime|cid:123')).toBeNull();
    expect(tvtimeUuid('MANUAL', id)).toBeNull();
    expect(tvtimeUuid('TVTIME', null)).toBeNull();
  });
  it('keeps five-star poll keys separate from 0–10 ratings and cast IDs', () => {
    const data = decodeEngagement(
      {
        entity: { type: 'episode', id: entity },
        rating: { average: 8 },
        options: {
          starRatings: [{ key: 'rating:27', stars: 2, count: 4 }],
          castVotes: [{ key: 'actor:123', label: 'Character', count: 2 }],
        },
      },
      { entityType: 'episode', entityId: entity } as any,
      false,
    );
    expect(data.sections[0].options[0].localValue).toBe('2');
    expect(data.sections[2].options[0].localValue).toBeNull();
    expect(data.rating?.average).toBe(8);
  });
});

describe('outbound request validation', () => {
  it('requires a timezone and rejects future timestamps', () => {
    expect(() => validateWrite({ text: 'x', createdAt: '2026-01-01T00:00:00' }, [])).toThrow();
    expect(() => validateWrite({ text: 'x', createdAt: '2099-01-01T00:00:00Z' }, [])).toThrow();
  });
  it('accepts an approved image-only post but rejects an empty post or unapproved host', () => {
    const attachment = {
      url: 'https://images.example/1.webp',
      provider: 'tvwatch',
      contentType: 'image/webp',
    };
    expect(() =>
      validateWrite({ createdAt: '2026-01-01T00:00:00Z', attachments: [attachment] }, [
        'images.example',
      ]),
    ).not.toThrow();
    expect(() => validateWrite({ createdAt: '2026-01-01T00:00:00Z' }, [])).toThrow();
    expect(() =>
      validateWrite({ createdAt: '2026-01-01T00:00:00Z', attachments: [attachment] }, []),
    ).toThrow();
  });
});

it('keeps vote receipts in the same actor namespace when only the API key rotates', () => {
  const { client, values } = setup();
  const before = { scope: client.scope, voteScope: client.voteScope, actor: client.actor('user') };
  values['commsuni.apiKey'] = 'rotated-fake-test-key';
  expect(client.scope).not.toBe(before.scope);
  expect(client.voteScope).toBe(before.voteScope);
  expect(client.actor('user')).toBe(before.actor);
  values['commsuni.sourceSlug'] = 'another-partner';
  expect(client.voteScope).not.toBe(before.voteScope);
});

describe('CommsUni media misses and recovery', () => {
  const originalFetch = global.fetch;
  let network: jest.Mock;
  beforeEach(() => {
    network = jest.fn();
    global.fetch = network;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('caches only an explicit media_not_found response', async () => {
    const { client } = setup();
    network.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'media_not_found' } }), { status: 404 }),
    );
    await expect(client.mediaUrl('alice', id)).resolves.toBeNull();
    await expect(client.mediaUrl('alice', id)).resolves.toBeNull();
    expect(network).toHaveBeenCalledTimes(1);
  });
  it('keeps a generic 404 retryable instead of hiding an image for two hours', async () => {
    const { client } = setup();
    network
      .mockResolvedValueOnce(new Response('temporary proxy error', { status: 404 }))
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'https://images.example/ok' } }),
      );
    await expect(client.mediaUrl('alice', id)).rejects.toMatchObject({
      status: 502,
      code: 'media_lookup_unavailable',
    });
    await expect(client.mediaUrl('alice', id)).resolves.toBe('https://images.example/ok');
    expect(network).toHaveBeenCalledTimes(2);
  });
  it('does not cache dependency failures as missing media', async () => {
    const { client, redis } = setup();
    network.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'redis_unavailable' } }), { status: 503 }),
    );
    await expect(client.mediaUrl('alice', id)).rejects.toMatchObject({ status: 503 });
    expect(redis.set.mock.calls.some(([key]) => key.includes('missing-media'))).toBe(false);
  });
  it('does not keep or reuse a signed delivery URL', async () => {
    const { client, redis } = setup();
    network.mockImplementation(
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://images.example/ok' } }),
    );
    await client.mediaUrl('alice', id);
    await client.mediaUrl('alice', id);
    expect(network).toHaveBeenCalledTimes(2);
    expect(redis.set).not.toHaveBeenCalled();
  });
});

it('exposes provider Retry-After to the mobile recovery policy', () => {
  const response: any = { setHeader: jest.fn(), status: jest.fn(), json: jest.fn() };
  response.status.mockReturnValue(response);
  const host: any = { switchToHttp: () => ({ getResponse: () => response }) };
  new CommsUniExceptionFilter().catch(new CommsUniError(429, 'quota_exceeded', undefined, 8), host);
  expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '8');
  expect(response.json).toHaveBeenCalledWith(
    expect.objectContaining({
      statusCode: 429,
      retryAfterSeconds: 8,
      code: 'quota_exceeded',
    }),
  );
});

describe('metered write delivery (fake HTTP and Redis)', () => {
  it('paces production writes and fails closed when Redis cannot reserve a slot', async () => {
    const f = setup(true);
    f.values.nodeEnv = 'production';
    const transport = jest.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const redis: any = { ...f.redis, client: { eval: jest.fn().mockResolvedValue(0) } };
    const client = new CommsUniClient(f.config as any, redis, transport);
    await client.request(actor, 'PUT', '/comments/' + id + '/like');
    expect(redis.client.eval).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    redis.client.eval.mockRejectedValue(Error('offline'));
    await expect(client.request(actor, 'PUT', '/comments/' + id + '/like')).rejects.toMatchObject({
      code: 'write_limiter_unavailable',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('defers a burst before HTTP instead of exceeding the reserved rate', async () => {
    const f = setup(true);
    f.values.nodeEnv = 'production';
    const transport = jest.fn();
    const client = new CommsUniClient(
      f.config as any,
      { ...f.redis, client: { eval: jest.fn().mockResolvedValue(6000) } } as any,
      transport,
    );
    await expect(client.request(actor, 'PUT', '/comments/' + id + '/like')).rejects.toMatchObject({
      status: 429,
      reason: 'client_rate',
    });
    expect(transport).not.toHaveBeenCalled();
  });
  it('pauses writes for a daily budget response and retains a sanitized detailed reason', async () => {
    const f = setup(true);
    const transport = jest.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 'quota_exceeded',
              reason: 'daily_budget',
              message:
                'Budget reached fake-unit-test-key Bearer private https://private.example/file',
            },
          }),
          { status: 429 },
        ),
    );
    const client = new CommsUniClient(f.config as any, f.redis as any, transport);
    let error: any;
    try {
      await client.request(actor, 'PUT', '/comments/' + id + '/like');
    } catch (e) {
      error = e;
    }
    expect(error.detailMessage).toContain('Budget reached');
    expect(error.detailMessage).not.toContain('fake-unit-test-key');
    expect(error.detailMessage).not.toContain('private');
    expect(await client.writePausedUntil()).toBeGreaterThan(Date.now() + 23 * 3600000);
    await expect(client.request(actor, 'PUT', '/comments/' + id + '/like')).rejects.toBeInstanceOf(
      CommsUniError,
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

it.each([
  'https://media.giphy.com/media/test/giphy.gif',
  ...Array.from({ length: 5 }, (_, i) => `https://media${i}.giphy.com/media/test/giphy.gif`),
  'https://media.tenor.com/test/tenor.gif',
  'https://cdn.klipy.com/test.gif',
  'https://new-gif-provider.example/asset?id=123',
])('does not require a local hostname registration for GIFs: %s', (url) => {
  expect(() =>
    validateWrite(
      {
        createdAt: '2026-01-01T00:00:00Z',
        attachments: [{ url, contentType: 'image/gif', provider: 'external' }],
      },
      ['api.tvwatchtime.org'],
    ),
  ).not.toThrow();
});
