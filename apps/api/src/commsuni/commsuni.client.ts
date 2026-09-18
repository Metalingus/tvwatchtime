import { Inject, Injectable, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomUUID } from 'crypto';
import { RedisService } from '../common/redis/redis.service';

export const COMMSUNI_HTTP = Symbol('COMMSUNI_HTTP');
export const COMMSUNI_BASE_URL = 'https://api.commsuni.tv/v1';
export const entityCacheResources = (target: {
  entityType?: string;
  threadType?: string;
  entityId?: string | null;
  reference?: string;
}) => [
  ...new Set(
    [target.entityId, target.reference]
      .filter(Boolean)
      .map((id) => 'entity:' + (target.entityType ?? target.threadType?.toLowerCase()) + ':' + id),
  ),
];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_PATH =
  /^\/(?:sources|health|entities\/(?:show|movie|season|episode)(?:\/[A-Za-z0-9:-]+\/(?:comments(?:\/search)?|conversation|engagement))?|comments\/[0-9a-f-]+(?:\/(?:replies|media))?|authors\/[0-9a-f-]+\/comments)$/i;
const WRITE_PATH =
  /^\/(?:authors\/me\/profile|entities\/(?:show|movie|season|episode)\/[A-Za-z0-9:-]+\/(?:comments|rating|engagement\/(?:emotion|star_rating|cast_vote|watch_device|watch_platform|movie_interest))|comments\/[0-9a-f-]+(?:\/(?:replies|like|spoiler|reports))?|media-grants)$/i;

export class CommsUniError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string,
    readonly retryAfterSeconds = 0,
    readonly requestId?: string,
    readonly detailMessage?: string,
  ) {
    super(`CommsUni ${status}: ${code}`);
  }
  get empty() {
    return this.status === 404 && ['not_archived', 'not_found'].includes(this.code);
  }
  get retryable() {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export interface CommsUniResponse<T> {
  data: T;
  duplicateReport: boolean;
  replayed: boolean;
}

@Injectable()
export class CommsUniClient {
  private readonly inFlight = new Map<string, Promise<unknown>>();
  constructor(
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    @Optional() @Inject(COMMSUNI_HTTP) private readonly http?: typeof fetch,
  ) {}

  get enabled(): boolean {
    return (
      this.config.get('commsuni.enabled') === true &&
      !!this.config.get<string>('commsuni.apiKey') &&
      (this.config.get<string>('commsuni.actorSecret')?.length ?? 0) >= 32
    );
  }

  get writesEnabled(): boolean {
    return (
      this.enabled &&
      this.config.get('commsuni.writesEnabled') === true &&
      /^[a-z0-9][a-z0-9_-]*$/.test(this.sourceSlug)
    );
  }

  get sourceSlug(): string {
    return this.config.get<string>('commsuni.sourceSlug') || '';
  }

  // Changing a credential must not silently replay old deliveries under a new identity.
  get scope(): string {
    return createHash('sha256')
      .update(
        `${COMMSUNI_BASE_URL}|${this.sourceSlug}|${this.config.get<string>('commsuni.apiKey') || ''}|${this.config.get<string>('commsuni.actorSecret') || ''}`,
      )
      .digest('hex')
      .slice(0, 32);
  }

  /** Vote receipts follow the partner actor identity across API-key rotation. */
  get voteScope(): string {
    return createHash('sha256')
      .update(
        `${COMMSUNI_BASE_URL}|${this.sourceSlug}|${this.config.get<string>('commsuni.actorSecret') || ''}`,
      )
      .digest('hex')
      .slice(0, 32);
  }

  actor(userId: string): string {
    if (!this.enabled || !userId) throw new ServiceUnavailableException('CommsUni is disabled');
    return createHmac('sha256', this.config.get<string>('commsuni.actorSecret')!)
      .update(userId)
      .digest('hex');
  }

  assertWrites(): void {
    if (!this.writesEnabled) throw new ServiceUnavailableException('CommsUni writes are disabled');
  }

  private resource(path: string) {
    const entity = /^\/entities\/([^/]+)\/([^/]+)/.exec(path);
    if (entity) return 'entity:' + entity[1] + ':' + entity[2];
    const comment = /^\/comments\/([^/]+)/.exec(path);
    return comment ? 'comment:' + comment[1] : path;
  }

  async cacheVersion(resource: string): Promise<string | number> {
    const namespace = createHash('sha256').update(resource).digest('hex').slice(0, 24);
    return (
      (await this.redis
        .get<string | number>('commsuni:read-version:' + this.scope + ':' + namespace)
        .catch(() => null)) ?? 0
    );
  }

  private async cacheKey(
    userId: string,
    path: string,
    query: Record<string, string | number | undefined>,
    resource = this.resource(path),
    readVersion?: string | number,
  ) {
    const actor = this.actor(userId);
    const namespace = createHash('sha256').update(resource).digest('hex').slice(0, 24);
    const version = readVersion ?? (await this.cacheVersion(resource));
    const suffix = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]): [string, string] => [k, String(v)]),
    ).toString();
    return (
      'commsuni:read:v2:' +
      this.scope +
      ':' +
      namespace +
      ':' +
      version +
      ':' +
      createHash('sha256')
        .update(actor + '|' + path + '|' + suffix)
        .digest('hex')
    );
  }

  /** Seed individual reads from the user's visible page, without retaining signed URLs. */
  async prime(
    userId: string,
    path: string,
    data: unknown,
    resource?: string,
    readVersion?: string | number,
  ) {
    const key = await this.cacheKey(userId, path, {}, resource, readVersion);
    await this.redis.set(key, data, 30).catch(() => undefined);
  }

  async read<T>(
    userId: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
    ttl = 30,
    resource?: string,
  ): Promise<T> {
    const actor = this.actor(userId);
    const key = await this.cacheKey(userId, path, query, resource);
    const cached = ttl > 0 ? await this.redis.get<T>(key).catch(() => null) : null;
    if (cached !== null) return cached;
    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;
    const work = (async () => {
      let result: CommsUniResponse<T>;
      try {
        result = await this.request<T>(actor, 'GET', path, query);
      } catch (error) {
        // Failure is never cached as an empty conversation, nor served from another actor.
        throw error;
      }
      if (ttl > 0) await this.redis.set(key, result.data, ttl).catch(() => undefined);
      return result.data;
    })();
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async invalidate(resources: string[] = []): Promise<void> {
    // An epoch makes invalidation constant-time and prevents an in-flight old read
    // from repopulating the active namespace. Unrelated entities/catalogs remain cached.
    for (const resource of new Set(resources)) {
      const namespace = createHash('sha256').update(resource).digest('hex').slice(0, 24);
      await this.redis.client.incr('commsuni:read-version:' + this.scope + ':' + namespace);
    }
  }

  async mediaGrants(userId: string, commentIds: string[]): Promise<unknown> {
    if (
      !commentIds.length ||
      commentIds.length > 16 ||
      new Set(commentIds).size !== commentIds.length ||
      commentIds.some((id) => !UUID.test(id))
    ) {
      throw new CommsUniError(400, 'invalid_media_grants');
    }
    const actor = this.actor(userId);
    const missingKey = (id: string) =>
      'commsuni:missing-media:v2:' + this.scope + ':' + actor + ':' + id;
    const missing = new Set<string>();
    await Promise.all(
      commentIds.map(async (id) => {
        if (await this.redis.get<boolean>(missingKey(id)).catch(() => false)) missing.add(id);
      }),
    );
    const needed = commentIds.filter((id) => !missing.has(id));
    const grants = new Map<string, Record<string, unknown>>();
    if (needed.length) {
      const response = await this.request<{ grants: Record<string, unknown>[] }>(
        actor,
        'POST',
        '/media-grants',
        {},
        { commentIds: needed },
        randomUUID(),
      );
      if (!Array.isArray(response.data?.grants))
        throw new CommsUniError(502, 'invalid_media_grants');
      for (const grant of response.data.grants) {
        if (
          typeof grant.commentId !== 'string' ||
          !needed.includes(grant.commentId) ||
          grants.has(grant.commentId) ||
          !['granted', 'missing'].includes(String(grant.status))
        )
          throw new CommsUniError(502, 'invalid_media_grants');
        grants.set(grant.commentId, grant);
        if (grant.status === 'missing') {
          await this.redis.set(missingKey(grant.commentId), true, 7200).catch(() => undefined);
        }
      }
      if (grants.size !== needed.length) throw new CommsUniError(502, 'incomplete_media_grants');
    }
    return {
      grants: commentIds.map(
        (commentId) => grants.get(commentId) ?? { commentId, status: 'missing' },
      ),
    };
  }

  async mediaUrl(userId: string, commentId: string): Promise<string | null> {
    if (!UUID.test(commentId)) throw new CommsUniError(400, 'invalid_comment_id');
    const missingKey = `commsuni:missing-media:v2:${this.scope}:${this.actor(userId)}:${commentId}`;
    if (await this.redis.get<boolean>(missingKey).catch(() => false)) return null;
    const response = await this.perform(this.actor(userId), 'GET', `/comments/${commentId}/media`);
    if (response.status === 302) {
      const location = response.headers.get('location');
      if (!location || new URL(location).protocol !== 'https:')
        throw new CommsUniError(502, 'invalid_media_redirect');
      return location;
    }
    try {
      await this.decode(response);
    } catch (error) {
      // Only the documented permanent media miss is cacheable. A generic/proxy 404
      // must not hide an existing attachment for two hours.
      if (
        error instanceof CommsUniError &&
        error.status === 404 &&
        error.code === 'media_not_found'
      ) {
        await this.redis.set(missingKey, true, 7200).catch(() => undefined);
        return null;
      }
      if (
        error instanceof CommsUniError &&
        error.status === 404 &&
        error.code !== 'comment_not_found'
      )
        throw new CommsUniError(502, 'media_lookup_unavailable');
      throw error;
    }
    throw new CommsUniError(502, 'invalid_media_redirect');
  }

  async writePausedUntil(): Promise<number> {
    const until = await this.redis
      .get<number>('commsuni:write-paused:' + this.scope)
      .catch(() => null);
    return typeof until === 'number' && until > Date.now() ? until : 0;
  }

  private async paceWrite(): Promise<void> {
    const paused = await this.writePausedUntil();
    if (paused)
      throw new CommsUniError(
        429,
        'quota_exceeded',
        'daily_budget',
        Math.ceil((paused - Date.now()) / 1000),
      );
    if (this.config.get('nodeEnv') === 'test') return;
    const interval = Math.max(
      100,
      Math.min(60000, Number(this.config.get('commsuni.writeIntervalMs')) || 1000),
    );
    let delay: number;
    try {
      delay = Number(
        await this.redis.client.eval(
          "local n=tonumber(redis.call('GET',KEYS[1]) or ARGV[1]); local now=tonumber(ARGV[1]); local d=math.max(0,n-now); if d>5000 then return d end; redis.call('SET',KEYS[1],math.max(now,n)+tonumber(ARGV[2]),'PX',math.max(10000,d+tonumber(ARGV[2])*2)); return d",
          1,
          'commsuni:write-slot:' + this.scope,
          Date.now(),
          interval,
        ),
      );
    } catch {
      throw new CommsUniError(503, 'write_limiter_unavailable');
    }
    if (!Number.isFinite(delay) || delay < 0)
      throw new CommsUniError(503, 'write_limiter_unavailable');
    if (delay > 5000)
      throw new CommsUniError(429, 'write_rate_wait', 'client_rate', Math.ceil(delay / 1000));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    this.assertWrites();
  }

  async request<T>(
    actor: string,
    method: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<CommsUniResponse<T>> {
    const response = await this.perform(actor, method, path, query, body, idempotencyKey);
    return {
      data: (await this.decode(response)) as T,
      duplicateReport: response.headers.get('report-duplicate') === 'true',
      replayed: response.headers.get('idempotency-replayed') === 'true',
    };
  }

  private async perform(
    actor: string,
    method: string,
    path: string,
    query: Record<string, string | number | undefined> = {},
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<Response> {
    if (!this.enabled) throw new ServiceUnavailableException('CommsUni is disabled');
    if (this.config.get('nodeEnv') === 'test' && !this.http)
      throw new ServiceUnavailableException('Tests require an injected mock CommsUni transport');
    const read = method === 'GET' || method === 'HEAD';
    const mediaRead = method === 'POST' && path === '/media-grants';
    if (!read && !mediaRead) this.assertWrites();
    if (!/^[a-f0-9]{64}$/.test(actor) || !(read ? READ_PATH : WRITE_PATH).test(path))
      throw new CommsUniError(400, 'invalid_request');
    if (!read && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method))
      throw new CommsUniError(400, 'invalid_method');
    if (method === 'POST' && !mediaRead && !idempotencyKey)
      throw new CommsUniError(400, 'idempotency_key_required');
    const url = new URL(COMMSUNI_BASE_URL + path);
    for (const [key, value] of Object.entries(query))
      if (value !== undefined) url.searchParams.set(key, String(value));
    const blockedUntil = await this.redis
      .get<number>(`commsuni:cooldown:${this.scope}:${actor}`)
      .catch(() => null);
    const partnerUntil = await this.redis
      .get<number>(`commsuni:cooldown:${this.scope}:partner`)
      .catch(() => null);
    const remaining = Math.max(blockedUntil || 0, partnerUntil || 0) - Date.now();
    if (remaining > 0) {
      const who = (blockedUntil ?? 0) >= (partnerUntil ?? 0) ? actor : 'partner';
      const reason = await this.redis
        .get<string>('commsuni:cooldown-reason:' + this.scope + ':' + who)
        .catch(() => null);
      throw new CommsUniError(
        429,
        'local_cooldown',
        reason ?? undefined,
        Math.ceil(remaining / 1000),
      );
    }
    // All headers are built here; no browser Origin, cookies, user JWT, or arbitrary URL.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.get<string>('commsuni.apiKey')}`,
      Accept: 'application/json',
      'X-TVTA-Actor-ID': actor,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    // A distributed write slot limits bursts from live activity and backfill together.
    if (!read && path !== '/media-grants') await this.paceWrite();
    // Last check before the network call: callers and workers cannot bypass the gate.
    if (!read && !mediaRead) this.assertWrites();
    let response: Response;
    try {
      response = await (this.http ?? fetch)(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new CommsUniError(0, 'transport_error');
    }
    if (response.status === 429 || response.status >= 500) {
      const hint = response.headers.get('retry-after');
      const seconds =
        hint && /^\d+$/.test(hint)
          ? Number(hint)
          : hint
            ? Math.max(0, Math.ceil((Date.parse(hint) - Date.now()) / 1000))
            : 5;
      const error = (await response
        .clone()
        .json()
        .catch(() => ({}))) as { error?: { reason?: string } };
      if (!read && !mediaRead && error.error?.reason === 'daily_budget') {
        const wait = hint && Number.isFinite(seconds) && seconds > 0 ? seconds : 86400;
        await this.redis
          .set('commsuni:write-paused:' + this.scope, Date.now() + wait * 1000, wait)
          .catch(() => undefined);
      }
      const who = [
        'actor_rate',
        'actor_denied',
        'unknown_actor_rate',
        'unknown_actor_denied',
      ].includes(error.error?.reason || '')
        ? actor
        : 'partner';
      const delay = Math.max(1, Number.isFinite(seconds) ? seconds : 5);
      await this.redis
        .set(`commsuni:cooldown:${this.scope}:${who}`, Date.now() + delay * 1000, delay)
        .catch(() => undefined);
      if (error.error?.reason)
        await this.redis
          .set('commsuni:cooldown-reason:' + this.scope + ':' + who, error.error.reason, delay)
          .catch(() => undefined);
    }
    const metric = response.headers.get('x-ratelimit-metric');
    if (metric)
      await this.redis
        .set(
          'commsuni:quota:' + this.scope,
          {
            metric,
            remaining: response.headers.get('ratelimit-remaining'),
            reset: response.headers.get('ratelimit-reset'),
            checkedAt: new Date().toISOString(),
            status: response.status,
          },
          3600,
        )
        .catch(() => undefined);
    return response;
  }

  private diagnosticMessage(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    let message = value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000);
    for (const key of ['commsuni.apiKey', 'commsuni.actorSecret']) {
      const secret = this.config.get<string>(key);
      if (secret) message = message.split(secret).join('[redacted]');
    }
    return message
      .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
      .replace(/https?:\/\/[^\s]+/gi, '[url]');
  }

  private async decode(response: Response): Promise<unknown> {
    // Reports acknowledge acceptance (including duplicates) with an empty 202.
    // request() still reads the verdict/replay headers after decoding.
    if (response.status === 202 || response.status === 204) return undefined;
    const payload = (await response.json().catch(() => null)) as {
      data?: unknown;
      error?: { code?: string; reason?: string; message?: string };
    } | null;
    if (!response.ok) {
      // Keep detailed messages off public errors/logs; the worker encrypts them for admin diagnostics.
      const raw = response.headers.get('retry-after');
      throw new CommsUniError(
        response.status,
        payload?.error?.code || 'upstream_error',
        payload?.error?.reason,
        raw
          ? /^\d+$/.test(raw)
            ? Number(raw)
            : Math.max(0, Math.ceil((Date.parse(raw) - Date.now()) / 1000)) || 0
          : 0,
        response.headers.get('x-request-id') || undefined,
        this.diagnosticMessage(payload?.error?.message),
      );
    }
    if (!payload || !Object.prototype.hasOwnProperty.call(payload, 'data'))
      throw new CommsUniError(502, 'invalid_envelope');
    return payload.data;
  }
}
