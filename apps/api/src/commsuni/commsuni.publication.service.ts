import { isLegacyClientRequest } from '../common/client-capabilities';
import { publicCommentImageUrl } from '../comment-images/lib/public-url';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, type Comment, type CommsUniOutbox } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { createHash, randomUUID } from 'crypto';
import type {
  CommsUniWriteComment,
  ConversationType,
  CommsUniEngagementKind,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { CommsUniClient, CommsUniError, UUID, entityCacheResources } from './commsuni.client';
import {
  conversationFingerprint,
  CommsUniResolver,
  type ResolvedConversation,
  UnmappedConversation,
} from './commsuni.resolver';
import { isAllowedGifUrl } from '../common/utils/gif-url';
import { acknowledgeVotes } from './commsuni.vote-receipts';
import { preferredOption } from './commsuni.option-mapping';
import { seal, unseal } from './commsuni.crypto';
import { validateWrite } from './commsuni.validation';
import { isProviderError } from '../media-metadata/providers/shared/provider-errors';
import {
  object,
  httpsUrl,
  CommsUniReadService,
  fixedOptionKey,
  tvtimeUuid,
} from './commsuni.read.service';

const QUEUE = 'commsuni-outbox';
const RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
type StoredTarget = {
  threadType: ConversationType;
  threadId: string;
  fingerprint: string;
  reference?: string;
  entityId?: string | null;
  notifyOnDelivery?: boolean;
  backfill?: { runId: string; cutoff: string };
};

function sameTarget(a: unknown, b: unknown): boolean {
  const left = object(a),
    right = object(b);
  return (
    ['threadType', 'threadId', 'fingerprint'].every((key) => left[key] === right[key]) &&
    (!left.reference || !right.reference || left.reference === right.reference) &&
    (!left.entityId || !right.entityId || left.entityId === right.entityId)
  );
}

@Injectable()
export class CommsUniPublicationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommsUniPublicationService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    readonly client: CommsUniClient,
    private readonly resolver: CommsUniResolver,
    private readonly reads?: CommsUniReadService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  private get secret() {
    return this.config.get<string>('commsuni.actorSecret') || '';
  }

  async onModuleInit() {
    // No worker, profile initialization, or upstream writes at all in the default mode.
    if (!this.client.writesEnabled) return;
    this.queue = new Queue(QUEUE, { connection: this.redis.client as any });
    this.worker = new Worker(QUEUE, () => this.drain(), {
      connection: this.redis.client as any,
      concurrency: 1,
    });
    this.worker.on('failed', () =>
      this.logger.warn('CommsUni outbox wakeup failed; durable records retained'),
    );
    await this.queue.add(
      'drain',
      {},
      { repeat: { every: 10000 }, jobId: 'drain', removeOnComplete: 5, removeOnFail: 20 },
    );
    await this.wake();
  }

  /** Prompt delivery after commit; the periodic drain recovers missed Redis wakeups. */
  async wake(): Promise<void> {
    if (!this.client.writesEnabled || !this.queue) return;
    try {
      // No fixed jobId: a write arriving during an active drain needs a subsequent pass.
      await this.queue.add('drain', {}, { removeOnComplete: true, removeOnFail: 20 });
    } catch {
      this.logger.warn('CommsUni wakeup unavailable; periodic drain will retry durable work');
    }
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
  }

  /** Authenticated local vote + durable intent commit together. No historical scan or provider call. */
  async voteTransaction<T>(
    userId: string,
    type: ConversationType,
    id: string,
    kind: CommsUniEngagementKind,
    value: string | null,
    selected: boolean,
    change: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (!this.client.writesEnabled || isLegacyClientRequest()) return change(this.prisma);
    const result = await this.prisma.$transaction(async (tx) => {
      const result = await change(tx);
      await this.captureVote(tx, userId, type, id, kind, value, selected);
      return result;
    });
    void this.wake();
    return result;
  }

  /** Capture a new explicit vote inside an existing local transaction. No provider call. */
  async captureVote(
    tx: Prisma.TransactionClient,
    userId: string,
    type: ConversationType,
    id: string,
    kind: CommsUniEngagementKind,
    value: string | null,
    selected: boolean,
  ): Promise<void> {
    if (!this.client.writesEnabled || isLegacyClientRequest()) return;
    const episode =
      type === 'EPISODE'
        ? await tx.episode.findUnique({
            where: { id },
            include: { externalIds: true, season: { include: { show: true } } },
          })
        : null;
    const mediaId = episode?.season.show.mediaId ?? id;
    const media = await tx.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: true },
    });
    if (!media || media.type !== (type === 'MOVIE' ? 'MOVIE' : 'SHOW')) return;
    const identity = await this.identity(tx, userId);
    const target = {
      threadType: type,
      threadId: id,
      fingerprint: conversationFingerprint(type, id, mediaId, media, episode),
    };
    await tx.commsUniOutbox.create({
      data: {
        identityId: identity.id,
        dedupeKey: 'vote:' + randomUUID(),
        method: 'LOCAL_VOTE',
        path: '/pending-engagement/' + kind,
        payload: seal(this.secret, { kind, value, selected }),
        target,
      },
    });
  }

  private async identity(tx: Prisma.TransactionClient, userId: string) {
    const existing = await tx.commsUniIdentity.findUnique({
      where: { userId_scope: { userId, scope: this.client.scope } },
    });
    if (existing) {
      if (existing.deleting) throw new BadRequestException('Account deletion is pending');
      return existing;
    }
    return tx.commsUniIdentity.create({
      data: {
        userId,
        scope: this.client.scope,
        actorEncrypted: seal(this.secret, this.client.actor(userId)),
      },
    });
  }

  /** Called by authenticated live creation or the reviewed backfill, inside its transaction. */
  async capture(
    tx: Prisma.TransactionClient,
    userId: string,
    comment: Comment,
    attachmentPending: boolean,
    mentions?: CommsUniWriteComment['mentions'],
    backfill?: { runId: string; cutoff: string },
    expectedTarget?: ResolvedConversation,
  ): Promise<void> {
    if (
      !this.client.writesEnabled ||
      (!backfill && isLegacyClientRequest()) ||
      comment.userId !== userId ||
      comment.hasLocalRevision ||
      (comment.commsUniOriginId && comment.commsUniOriginId !== comment.id) ||
      comment.source !== 'MANUAL' ||
      comment.sourceKey ||
      comment.threadType === 'GROUP' ||
      comment.externalReviewId ||
      comment.mediaId ||
      comment.listId
    )
      return;
    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isSuspended: true, isShadow: true },
    });
    if (!user || user.isShadow || user.isSuspended) return;
    if (comment.parentId) {
      const parent = await tx.comment.findUnique({ where: { id: comment.parentId } });
      if (parent?.hasLocalRevision) return;
      if (!parent?.commsUniCommentId && !parent?.commsUniState && !comment.commsUniParentId) {
        const original = parent?.commsUniOriginId
          ? await tx.comment.findUnique({ where: { id: parent.commsUniOriginId } })
          : null;
        const remoteParentId =
          original?.commsUniCommentId ??
          tvtimeUuid(parent?.source ?? null, parent?.sourceKey ?? null);
        if (!remoteParentId || !UUID.test(remoteParentId)) return;
        // This reference is only an intent. Dispatch must verify the parent against
        // the resolved conversation before a provider write; the import itself is never sent.
        await tx.comment.update({
          where: { id: comment.id },
          data: { commsUniParentId: remoteParentId },
        });
        comment.commsUniParentId = remoteParentId;
      }
    }
    const episode =
      comment.threadType === 'EPISODE'
        ? await tx.episode.findUnique({
            where: { id: comment.threadId },
            include: { externalIds: true, season: { include: { show: true } } },
          })
        : null;
    const mediaId = episode?.season.show.mediaId ?? comment.threadId;
    const media = await tx.mediaItem.findUnique({
      where: { id: mediaId },
      include: { externalIds: true, show: true },
    });
    if (!media || media.type !== (comment.threadType === 'MOVIE' ? 'MOVIE' : 'SHOW')) return;
    const target: StoredTarget = {
      threadType: comment.threadType as ConversationType,
      threadId: comment.threadId,
      notifyOnDelivery: !comment.parentId,
      fingerprint: conversationFingerprint(
        comment.threadType,
        comment.threadId,
        mediaId,
        media,
        episode,
      ),
    };
    // Moderation belongs to local creation/edit/upload. Delivery trusts stored content,
    // including historical originals, and never calls the moderation provider again.
    if (expectedTarget) {
      if (
        target.fingerprint !== expectedTarget.fingerprint ||
        target.threadId !== expectedTarget.threadId
      )
        throw new BadRequestException('Preview mapping changed');
      target.reference = expectedTarget.reference;
      target.entityId = expectedTarget.entityId;
    }
    if (backfill) target.backfill = backfill;
    const identity = await this.identity(tx, userId);
    const body = this.commentBody(
      attachmentPending
        ? { ...comment, imageUrl: null, image: null }
        : (comment as Comment & { image?: any }),
    );
    if (mentions?.length) body.mentions = mentions;
    const image = (comment as Comment & { image?: { id: string } | null }).image;
    if (!attachmentPending && !comment.gifUrl && image) {
      const pinned = await tx.commentImage.updateMany({
        where: { id: image.id, commentId: comment.id, status: 'ready' },
        data: { retainedCommentId: comment.id },
      });
      if (pinned.count !== 1) throw new BadRequestException('Image changed before publication');
    }
    await tx.commsUniOutbox.create({
      data: {
        identityId: identity.id,
        dedupeKey: 'comment:' + comment.id,
        commentId: comment.id,
        method: 'POST',
        path: '/pending',
        payload: seal(this.secret, body),
        target: target as unknown as Prisma.InputJsonValue,
        state: attachmentPending ? 'WAITING_ATTACHMENT' : 'PENDING',
      },
    });
    await tx.comment.update({
      where: { id: comment.id },
      data: {
        commsUniOriginId: comment.id,
        commsUniState: attachmentPending ? 'WAITING_ATTACHMENT' : 'PENDING',
      },
    });
    comment.commsUniOriginId = comment.id;
    comment.commsUniState = attachmentPending ? 'WAITING_ATTACHMENT' : 'PENDING';
  }

  /** The same payload builder is used for live capture and reviewed historical rows. */
  commentBody(
    comment: Comment & {
      image?: { id: string; status: string; storageKey?: string | null } | null;
    },
  ): CommsUniWriteComment {
    const body: CommsUniWriteComment = {
      text: comment.body,
      isSpoiler: comment.isSpoiler,
      createdAt: comment.createdAt.toISOString(),
      ...(comment.language ? { language: comment.language } : {}),
    };
    if (comment.gifUrl) {
      if (!isAllowedGifUrl(comment.gifUrl)) throw new BadRequestException('Invalid GIF URL');
      const host = new URL(comment.gifUrl).hostname.toLowerCase();
      body.attachments = [
        {
          url: comment.gifUrl,
          contentType: 'image/gif',
          provider: host === 'giphy.com' || host.endsWith('.giphy.com') ? 'giphy' : 'external',
        },
      ];
    } else if (comment.image) {
      if (comment.image.status !== 'ready') throw new BadRequestException('attachment_not_ready');
      const url = publicCommentImageUrl(this.config, comment.image.id);
      body.attachments = [
        {
          url,
          contentType: comment.image.storageKey?.includes('.gif.enc') ? 'image/gif' : 'image/webp',
          provider: this.client.sourceSlug,
        },
      ];
    } else if (comment.imageUrl) {
      const url = httpsUrl(comment.imageUrl);
      const extension = url ? new URL(url).pathname.toLowerCase().split('.').pop() : undefined;
      const formats: Record<string, string> = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        webp: 'image/webp',
        gif: 'image/gif',
        avif: 'image/avif',
      };
      if (!url || !extension || !formats[extension])
        throw new BadRequestException('legacy_attachment_needs_review');
      body.attachments = [
        { url, contentType: formats[extension], provider: this.client.sourceSlug },
      ];
    }
    return body;
  }

  async finalize(userId: string, commentId: string) {
    const finalized = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRawUnsafe('SELECT id FROM comments WHERE id = $1 FOR UPDATE', commentId);
      const comment = await tx.comment.findFirst({
        where: { id: commentId, userId },
        include: { image: true },
      });
      if (!comment) throw new BadRequestException('Unknown comment');
      const operation = await tx.commsUniOutbox.findUnique({
        where: { dedupeKey: 'comment:' + commentId },
      });
      if (!operation || operation.firstAttemptAt || operation.state !== 'WAITING_ATTACHMENT')
        return;
      // An older client changed an unfinished shared draft. Keep its local revision,
      // rather than attaching newly edited media to an older captured text snapshot.
      if (
        comment.hasLocalRevision ||
        comment.deletedByUser ||
        comment.adminDeleted ||
        comment.hidden
      ) {
        await tx.commsUniOutbox.update({
          where: { id: operation.id },
          data: { state: 'CANCELED' },
        });
        await tx.comment.update({ where: { id: commentId }, data: { commsUniState: 'CANCELED' } });
        return;
      }
      if (comment.image?.status !== 'ready') throw new BadRequestException('Image is not ready');
      const body = unseal<CommsUniWriteComment>(this.secret, operation.payload);
      body.attachments = [
        {
          url: publicCommentImageUrl(this.config, comment.image.id),
          contentType: comment.image.storageKey?.includes('.gif.enc') ? 'image/gif' : 'image/webp',
          provider: this.client.sourceSlug,
        },
      ];
      validateWrite(body, this.config.get<string[]>('commsuni.mediaHosts') ?? []);
      await tx.commentImage.update({
        where: { id: comment.image.id },
        data: { retainedCommentId: commentId },
      });
      await tx.commsUniOutbox.update({
        where: { id: operation.id },
        data: { payload: seal(this.secret, body), state: 'PENDING' },
      });
      await tx.comment.update({ where: { id: commentId }, data: { commsUniState: 'PENDING' } });
      return true;
    });
    if (finalized) void this.wake();
  }

  async enqueue(
    userId: string,
    method: string,
    path: string,
    body: unknown,
    actionId: string,
    target?: StoredTarget,
    cleanup = false,
    localMutation?: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    this.client.assertWrites();
    if (!UUID.test(actionId)) throw new BadRequestException('Invalid action ID');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.isShadow || (user.isSuspended && !path.endsWith('/reports')))
      throw new BadRequestException('Publishing is unavailable for this account');
    const operation = await this.prisma.$transaction(async (tx) => {
      const identity = await this.identity(tx, userId);
      const dedupeKey = identity.id + ':' + actionId;
      const existing = await tx.commsUniOutbox.findUnique({ where: { dedupeKey } });
      if (existing) {
        if (
          existing.method !== method ||
          (method !== 'SELECTION' && existing.path !== path) ||
          (method === 'SELECTION' && !sameTarget(existing.target, target)) ||
          JSON.stringify(
            method === 'SELECTION'
              ? object(unseal(this.secret, existing.payload)).intent
              : unseal(this.secret, existing.payload),
          ) !== JSON.stringify(method === 'SELECTION' ? object(body).intent : body)
        )
          throw new BadRequestException('Action ID was reused');
        return existing;
      }
      await localMutation?.(tx);
      return tx.commsUniOutbox.create({
        data: {
          identityId: identity.id,
          dedupeKey,
          method,
          path,
          payload: seal(this.secret, body),
          ...(target ? { target: target as unknown as Prisma.InputJsonValue } : {}),
          cleanup,
        },
      });
    });
    void this.wake();
    return operation;
  }

  async drain(): Promise<void> {
    if (!this.client.writesEnabled || (await this.client.writePausedUntil?.())) return;
    const waiting = await this.prisma.commsUniOutbox.findMany({
      where: {
        identity: { scope: this.client.scope, deleting: false },
        state: 'WAITING_ATTACHMENT',
      },
      include: { identity: { select: { userId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    for (const operation of waiting) {
      if (operation.commentId && operation.identity.userId)
        await this.finalize(operation.identity.userId, operation.commentId).catch(() => undefined);
    }
    const rows = await this.prisma.commsUniOutbox.findMany({
      where: {
        identity: { scope: this.client.scope },
        OR: [
          {
            state: { in: ['PENDING', 'RETRY', 'WAITING_PARENT'] },
            nextAttemptAt: { lte: new Date() },
          },
          // Resume rows held only by the retired second moderation check.
          { state: 'WAITING_REVIEW', errorCode: 'moderation_required', firstAttemptAt: null },
          { state: 'SENDING', updatedAt: { lt: new Date(Date.now() - 120000) } },
          ...(this.config.get('commsuni.backfillEnabled') === true
            ? [{ state: 'BACKFILL_PAUSED' }]
            : []),
        ],
      },
      orderBy: { sequence: 'asc' },
      take: 25,
    });
    for (const row of rows) {
      if (!this.client.writesEnabled) return;
      const lock = 'commsuni:writer:' + row.identityId;
      const token = randomUUID();
      if ((await this.redis.client.set(lock, token, 'EX', 120, 'NX')) !== 'OK') continue;
      const renew = setInterval(() => {
        void this.redis.client
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], 120) end",
            1,
            lock,
            token,
          )
          .catch(() => undefined);
      }, 30000);
      try {
        await this.dispatch(row.id, { key: lock, token });
      } finally {
        clearInterval(renew);
        await this.redis.client
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end",
            1,
            lock,
            token,
          )
          .catch(() => undefined);
      }
    }
  }

  // Kept separately so tests can exercise delivery with an isolated fake HTTP transport.
  async dispatch(id: string, lease?: { key: string; token: string }): Promise<void> {
    if (!this.client.writesEnabled) return;
    const row = await this.prisma.commsUniOutbox.findUnique({
      where: { id },
      include: { identity: { include: { user: { include: { profile: true } } } } },
    });
    if (
      !row ||
      row.identity.scope !== this.client.scope ||
      (!['PENDING', 'RETRY', 'SENDING', 'WAITING_PARENT', 'BACKFILL_PAUSED'].includes(row.state) &&
        !(
          row.state === 'WAITING_REVIEW' &&
          row.errorCode === 'moderation_required' &&
          !row.firstAttemptAt
        ))
    )
      return;
    const isBackfill = !!object(row.target).backfill;
    if (isBackfill && this.config.get('commsuni.backfillEnabled') !== true) {
      if (row.state !== 'BACKFILL_PAUSED')
        await this.state(row, 'BACKFILL_PAUSED', 'backfill_disabled');
      return;
    }
    const older = await this.prisma.commsUniOutbox.count({
      where: {
        identityId: row.identityId,
        sequence: { lt: row.sequence },
        state: { in: ['PENDING', 'RETRY', 'SENDING'] },
      },
    });
    if (older) return;
    const user = row.identity.user;
    if (
      !row.cleanup &&
      (!user ||
        row.identity.deleting ||
        user.isShadow ||
        (user.isSuspended && !row.path.endsWith('/reports')))
    ) {
      await this.state(row, row.firstAttemptAt ? 'UNCERTAIN' : 'CANCELED', 'account_unavailable');
      return;
    }
    if (
      row.method === 'POST' &&
      row.firstAttemptAt &&
      Date.now() - row.firstAttemptAt.getTime() >= RETRY_WINDOW_MS
    ) {
      await this.state(row, 'UNCERTAIN', 'idempotency_window_expired');
      return;
    }
    const hadPriorAttempt = row.firstAttemptAt != null;
    let attemptedThisRun = false;
    const assertCurrent = async () => {
      this.client.assertWrites();
      if (isBackfill && this.config.get('commsuni.backfillEnabled') !== true)
        throw new CommsUniError(503, 'backfill_disabled');
      if (lease && (await this.redis.client.get(lease.key)) !== lease.token)
        throw new CommsUniError(503, 'writer_lease_lost');
      if (!row.cleanup) {
        const current = await this.prisma.commsUniIdentity.findUnique({
          where: { id: row.identityId },
          include: { user: { select: { isSuspended: true, isShadow: true } } },
        });
        if (
          !current ||
          current.deleting ||
          !current.user ||
          current.user.isShadow ||
          (current.user.isSuspended && !row.path.endsWith('/reports'))
        )
          throw new BadRequestException('Publishing is unavailable for this account');
      }
    };
    try {
      let body = row.payload ? unseal<any>(this.secret, row.payload) : undefined;
      let path = row.path;
      let method = row.method;
      let target: ResolvedConversation | undefined;
      const stored = row.target as unknown as StoredTarget | null;
      if (stored?.threadType && stored.threadId && !row.cleanup) {
        target = await this.resolver.resolve(user!.id, stored.threadType, stored.threadId);
        if (
          target.fingerprint !== stored.fingerprint ||
          (stored.reference != null && stored.reference !== target.reference) ||
          (stored.entityId != null && stored.entityId !== target.entityId)
        ) {
          await this.state(row, 'BLOCKED_MAPPING', 'mapping_changed');
          return;
        }
      }
      if (method === 'LOCAL_VOTE' || (method === 'SELECTION' && !row.firstAttemptAt)) {
        if (!this.reads || !target || !user)
          throw new BadRequestException('Vote mapping is unavailable');
        const data = await this.reads.engagement(user.id, target.threadType, target.threadId);
        const localIntent =
          method === 'LOCAL_VOTE' ||
          Object.prototype.hasOwnProperty.call(body.intent ?? {}, 'value');
        const kind = method === 'LOCAL_VOTE' ? body.kind : body.intent?.kind;
        const section = data.sections.find((item) => item.kind === kind);
        const intent = method === 'LOCAL_VOTE' ? body : body.intent;
        if (!intent) throw new BadRequestException('Missing selection intent');
        const match =
          section?.options.filter((option) =>
            localIntent
              ? option.localValue != null && option.localValue === intent.value
              : option.key === intent.optionKey,
          ) ?? [];
        // Fixed keys can fill an empty/partial verified catalog, but must not override a
        // returned catalog whose identities failed decoding (for example rating:29 says 3 stars).
        const fixed =
          localIntent && !(section?.options ?? []).some((option) => !option.localValue)
            ? fixedOptionKey(kind, intent.value)
            : null;
        const mapped =
          localIntent && intent.value != null
            ? preferredOption(section?.options ?? [], intent.value)
            : match[0];
        if (intent.value !== null && !mapped && !fixed) {
          await this.state(row, 'BLOCKED_OPTION', 'unverified_option_identity');
          return;
        }
        const requests: {
          method: 'PUT' | 'DELETE';
          body: { optionKey: string; entity?: { title: string; showTitle?: string } };
        }[] = [];
        const key = mapped?.key ?? fixed;
        path = this.resolver.path(target) + '/engagement/' + kind;
        // The provider may serve a read snapshot from before our previous write.
        // Our last acknowledged selection is authoritative for this actor/destination.
        const previous = await this.prisma.commsUniOutbox.findFirst({
          where: {
            identityId: row.identityId,
            method: 'SELECTION',
            path: { endsWith: '/engagement/' + kind },
            target: { path: ['fingerprint'], equals: target.fingerprint },
            state: 'SYNCED',
            sequence: { lt: row.sequence },
          },
          orderBy: { sequence: 'desc' },
        });
        const saved = previous?.payload ? object(unseal(this.secret, previous.payload)) : {};
        const selected = new Set<string>(
          Array.isArray(saved.selectedKeys)
            ? saved.selectedKeys.filter((value): value is string => typeof value === 'string')
            : (section?.options ?? [])
                .filter((option) => option.selected)
                .map((option) => option.key),
        );
        if (kind !== 'emotion') {
          const aliases = new Set(match.map((option) => option.key));
          for (const optionKey of selected) {
            if (
              (intent.selected && optionKey !== key) ||
              (!intent.selected && (intent.value === null || aliases.has(optionKey)))
            ) {
              requests.push({ method: 'DELETE', body: { optionKey } });
            }
          }
        }
        if (
          key &&
          (target.entityId || intent.selected) &&
          !requests.some(
            (request) =>
              request.body.optionKey === key && request.method === 'DELETE' && !intent.selected,
          )
        )
          requests.push({
            method: intent.selected ? 'PUT' : 'DELETE',
            body: {
              optionKey: key,
              ...(!target.entityId && intent.selected
                ? {
                    entity: {
                      title: target.title,
                      ...(target.showTitle ? { showTitle: target.showTitle } : {}),
                    },
                  }
                : {}),
            },
          });
        for (const request of requests) {
          if (request.method === 'PUT') selected.add(request.body.optionKey);
          else selected.delete(request.body.optionKey);
        }
        body = { intent, requests, selectedKeys: [...selected], nextRequest: 0 };
        method = 'SELECTION';
        await this.prisma.commsUniOutbox.update({
          where: { id },
          data: {
            method,
            path,
            payload: seal(this.secret, body),
            target: {
              ...object(row.target),
              reference: target.reference,
              entityId: target.entityId,
            } as Prisma.InputJsonValue,
          },
        });
      }
      if (row.commentId) {
        const comment = await this.prisma.comment.findUnique({ where: { id: row.commentId } });
        if (
          !comment ||
          comment.deletedByUser ||
          comment.adminDeleted ||
          comment.hidden ||
          comment.source !== 'MANUAL' ||
          comment.sourceKey ||
          comment.commsUniOriginId !== comment.id
        ) {
          await this.state(
            row,
            row.firstAttemptAt ? 'UNCERTAIN' : 'CANCELED',
            'comment_unavailable',
          );
          return;
        }
        if (!row.firstAttemptAt) {
          const parent = comment.parentId
            ? await this.prisma.comment.findUnique({ where: { id: comment.parentId } })
            : null;
          const parentId = comment.commsUniParentId ?? parent?.commsUniCommentId;
          if (comment.parentId && !parentId) {
            const waiting =
              parent &&
              [
                'PENDING',
                'RETRY',
                'SENDING',
                'WAITING_ATTACHMENT',
                'WAITING_REVIEW',
                'WAITING_PARENT',
                'BACKFILL_PAUSED',
              ].includes(parent.commsUniState ?? '');
            await this.state(
              row,
              waiting ? 'WAITING_PARENT' : 'BLOCKED_PARENT',
              'parent_not_published',
            );
            return;
          }
          if (parentId) {
            if (!this.reads || !target)
              throw new BadRequestException('Reply verification is unavailable');
            const visibleParent = await this.reads.comment(user!.id, target, parentId);
            const remoteParent = {
              id: visibleParent.id,
              entityId: visibleParent.entityId,
              userId: visibleParent.author.id,
              createdAt: visibleParent.createdAt,
            };
            if (
              String(remoteParent.id).toLowerCase() !== parentId.toLowerCase() ||
              remoteParent.entityId !== target?.entityId ||
              !visibleParent.actions.reply
            )
              throw new BadRequestException('Reply target does not belong to this conversation');
            if (
              body.mentions?.some(
                (mention: { authorId: string }) => mention.authorId !== remoteParent.userId,
              )
            )
              throw new BadRequestException('Mention does not identify the reply target');
            if (
              typeof remoteParent.createdAt === 'string' &&
              Date.parse(body.createdAt) < Date.parse(remoteParent.createdAt)
            )
              throw new BadRequestException('Reply timestamp precedes parent');
            path = '/comments/' + parentId + '/replies';
          } else {
            path = this.resolver.path(target!) + '/comments';
            if (!target!.entityId)
              body.entity = {
                title: target!.title,
                ...(target!.showTitle ? { showTitle: target!.showTitle } : {}),
              };
          }
          validateWrite(body, this.config.get<string[]>('commsuni.mediaHosts') ?? []);
          // Freeze the exact request before the first possible transmission.
          await this.prisma.commsUniOutbox.update({
            where: { id },
            data: {
              path,
              payload: seal(this.secret, body),
              target: {
                ...object(row.target),
                reference: target?.reference,
                entityId: target?.entityId,
              } as Prisma.InputJsonValue,
            },
          });
        }
      }
      const actor = unseal<string>(this.secret, row.identity.actorEncrypted);
      // Shared comments retain the user's TVWatch display identity. Profile updates
      // use the same stable actor and the same write/suspension/deletion gates.
      if (row.commentId && user && !row.cleanup) {
        const avatar = httpsUrl(user.profile?.avatarUrl);
        const hosts = this.config.get<string[]>('commsuni.avatarHosts') ?? [];
        const profile = {
          displayName: user.profile?.displayName?.trim() || user.username,
          avatarUrl:
            avatar && hosts.includes(new URL(avatar).hostname.toLowerCase()) ? avatar : null,
        };
        const profileHash = createHash('sha256').update(JSON.stringify(profile)).digest('hex');
        if (row.identity.profileHash !== profileHash || !row.identity.authorId) {
          await assertCurrent();
          const response = await this.client.request<{ authorId: string }>(
            actor,
            'PUT',
            '/authors/me/profile',
            {},
            profile,
          );
          const authorId = response.data?.authorId;
          if (
            !UUID.test(String(authorId)) ||
            (row.identity.authorId && authorId !== row.identity.authorId)
          )
            throw new CommsUniError(502, 'profile_identity_mismatch');
          try {
            await this.prisma.commsUniIdentity.update({
              where: { id: row.identityId },
              data: { authorId, profileHash },
            });
          } catch {
            // PUT is idempotent; a lost local acknowledgement must not strand the comment.
            throw new CommsUniError(0, 'profile_acknowledgement_not_saved');
          }
          // Check the comment acknowledgement against the identity just established.
          row.identity.authorId = authorId;
          row.identity.profileHash = profileHash;
        }
      }
      await assertCurrent();
      if (method === 'SELECTION') {
        // Check receipt storage before marking an attempt or making any provider mutation.
        await this.prisma.commsUniVoteReceipt.findFirst({ select: { id: true } }).catch(() => {
          throw new CommsUniError(0, 'vote_receipt_storage_unavailable');
        });
      }
      await this.prisma.commsUniOutbox.update({
        where: { id },
        data: {
          state: 'SENDING',
          firstAttemptAt: row.firstAttemptAt ?? new Date(),
          attempts: { increment: 1 },
        },
      });
      attemptedThisRun = true;
      let response: { data: any; duplicateReport: boolean } = {
        data: null,
        duplicateReport: false,
      };
      if (method === 'SELECTION') {
        if (Array.isArray(body)) body = { requests: body, nextRequest: 0 };
        const requests = body.requests as { method: 'PUT' | 'DELETE'; body: unknown }[];
        const next = body.nextRequest ?? 0;
        if (
          !Array.isArray(requests) ||
          !Number.isInteger(next) ||
          next < 0 ||
          next > requests.length
        )
          throw new BadRequestException('Invalid selection progress');
        for (let index = next; index < requests.length; index++) {
          const request = requests[index];
          await assertCurrent();
          await this.client.request(actor, request.method, path, {}, request.body, row.id);
          body.nextRequest = index + 1;
          // Persist each acknowledged step so a rate limit cannot make a replacement
          // repeatedly clear the old choice without ever setting the new one.
          await this.prisma.commsUniOutbox.update({
            where: { id },
            data: { payload: seal(this.secret, body) },
          });
        }
      } else {
        response = await this.client.request<any>(
          actor,
          method,
          path,
          {},
          body ?? undefined,
          row.id,
        );
      }
      const remote = object(response.data?.comment);
      if (
        row.commentId &&
        (!UUID.test(String(remote.id)) ||
          !UUID.test(String(remote.entityId)) ||
          !UUID.test(String(remote.userId)) ||
          (row.identity.authorId && remote.userId !== row.identity.authorId) ||
          (target?.entityId && remote.entityId !== target.entityId))
      )
        throw new CommsUniError(502, 'write_identity_mismatch');
      await this.prisma.$transaction(async (tx) => {
        if (
          method === 'SELECTION' &&
          target &&
          body.intent &&
          Object.prototype.hasOwnProperty.call(body.intent, 'value')
        ) {
          await acknowledgeVotes(
            tx,
            this.client.voteScope,
            actor,
            target,
            body.intent.kind,
            body.selectedKeys,
            row.sequence,
          );
        }
        await tx.commsUniOutbox.update({
          where: { id },
          data: {
            state: response.duplicateReport ? 'DUPLICATE_REPORT' : 'SYNCED',
            remoteId: typeof remote.id === 'string' ? remote.id : null,
            ...(row.commentId && target
              ? {
                  target: {
                    ...object(row.target),
                    reference: target.reference,
                    entityId: String(remote.entityId),
                  } as Prisma.InputJsonValue,
                }
              : {}),
            errorCode: null,
          },
        });
        if (target && !target.entityId) {
          // Never overwrite a mapping that was changed while the request was in flight.
          await tx.commsUniBinding.updateMany({
            where: {
              scope: row.identity.scope,
              threadType: target.threadType,
              threadId: target.threadId,
              fingerprint: target.fingerprint,
              entityId: null,
            },
            data: row.commentId
              ? { entityId: String(remote.entityId), verifiedAt: new Date() }
              : { verifiedAt: new Date(0) },
          });
        }
        if (row.commentId) {
          await tx.commsUniIdentity.update({
            where: { id: row.identityId },
            data: { authorId: String(remote.userId) },
          });
          await tx.comment.updateMany({
            where: { id: row.commentId },
            data: {
              commsUniCommentId: String(remote.id),
              commsUniEntityId: String(remote.entityId),
              commsUniState: 'SYNCED',
            },
          });
          const current = await tx.comment.findUnique({
            where: { id: row.commentId },
            select: { deletedByUser: true, hidden: true, adminDeleted: true },
          });
          const identity = await tx.commsUniIdentity.findUnique({
            where: { id: row.identityId },
            select: { deleting: true },
          });
          if (
            !current ||
            current.deletedByUser ||
            current.hidden ||
            current.adminDeleted ||
            identity?.deleting
          ) {
            const dedupeKey = 'comment-delete:' + row.id;
            await tx.commsUniOutbox.upsert({
              where: { dedupeKey },
              update: {},
              create: {
                identityId: row.identityId,
                dedupeKey,
                method: 'DELETE',
                path: '/comments/' + remote.id,
                payload: '',
                target: {
                  ...object(row.target),
                  entityId: String(remote.entityId),
                  reference: target?.reference,
                } as Prisma.InputJsonValue,
                cleanup: true,
              },
            });
          }
        }
      });
      if (user && !row.cleanup && !stored?.backfill && stored?.notifyOnDelivery !== false) {
        const match = /^\/comments\/([0-9a-f-]+)\/(replies|like)$/.exec(path);
        if (
          match &&
          ((method === 'POST' && match[2] === 'replies') ||
            (method === 'PUT' && match[2] === 'like'))
        ) {
          this.events?.emit('commsuni.interaction', {
            userId: user.id,
            remoteParentId: match[1],
            kind: match[2] === 'replies' ? 'reply' : 'like',
            operationId: row.id,
          });
        }
      }
      if (row.cleanup) {
        const identity = await this.prisma.commsUniIdentity.findUnique({
          where: { id: row.identityId },
          select: { userId: true, deleting: true },
        });
        if (identity?.deleting && !identity.userId) {
          const outstanding = await this.prisma.commsUniOutbox.count({
            where: {
              identityId: row.identityId,
              state: { notIn: ['SYNCED', 'DUPLICATE_REPORT', 'CANCELED'] },
            },
          });
          if (outstanding === 0)
            await this.prisma.commsUniIdentity.delete({ where: { id: row.identityId } });
        }
      }
      const affectedComment = /^\/comments\/([^/]+)/.exec(path)?.[1];
      await this.client
        .invalidate([
          ...entityCacheResources(target ?? object(row.target)),
          ...(typeof remote.id === 'string' ? ['comment:' + remote.id] : []),
          ...(affectedComment ? ['comment:' + affectedComment] : []),
        ])
        .catch(() => undefined);
    } catch (error) {
      if (!this.client.writesEnabled) return;
      if (error instanceof CommsUniError && error.code === 'backfill_disabled') {
        await this.state(row, 'BACKFILL_PAUSED', error.code);
        return;
      }
      if (isProviderError(error) && error.category !== 'not_found')
        error = new CommsUniError(503, 'metadata_unavailable');
      if (
        attemptedThisRun &&
        !(error instanceof CommsUniError) &&
        !(error instanceof BadRequestException)
      )
        error = new CommsUniError(0, 'acknowledgement_not_saved');
      if (error instanceof CommsUniError) {
        const latest = await this.prisma.commsUniOutbox
          .findUnique({
            where: { id },
            select: { target: true, payload: true },
          })
          .catch(() => null);
        await this.prisma.commsUniOutbox
          .update({
            where: { id },
            data: {
              target: {
                ...object(latest?.target ?? row.target),
                // A first, explicit rejection with no acknowledged selection steps is
                // not ambiguous. Earlier transmissions/partial selections still need reconciliation.
                ...(row.method === 'SELECTION' || row.method === 'LOCAL_VOTE'
                  ? {
                      deliveryUncertain:
                        (hadPriorAttempt && object(row.target).deliveryUncertain !== false) ||
                        (attemptedThisRun &&
                          !(error.status >= 400 && error.status < 500) &&
                          !['write_limiter_unavailable', 'writer_lease_lost'].includes(
                            error.code,
                          )) ||
                        (attemptedThisRun &&
                          Number(
                            object(unseal(this.secret, latest?.payload || row.payload))
                              .nextRequest ?? 0,
                          ) > 0),
                    }
                  : {}),
                lastError: {
                  status: error.status,
                  code: error.code,
                  reason: error.reason ?? null,
                  requestId: error.requestId ?? null,
                  at: new Date().toISOString(),
                  messageEncrypted: error.detailMessage
                    ? seal(this.secret, error.detailMessage)
                    : null,
                },
              } as Prisma.InputJsonValue,
            },
          })
          .catch(() => undefined);
      }
      if (
        error instanceof CommsUniError &&
        ['actor_denied', 'unknown_actor_denied'].includes(error.reason ?? '')
      ) {
        await this.state(row, 'FAILED', error.reason!);
        return;
      }
      if (error instanceof CommsUniError && error.retryable) {
        // A confirmed first-request rejection never entered the POST ledger. Keep the
        // uncertainty clock only when some earlier transmission may have succeeded.
        const rejectedBeforeMutation =
          error.status === 429 ||
          ['write_limiter_unavailable', 'writer_lease_lost', 'archive_writes_maintenance'].includes(
            error.code,
          );
        const delay =
          Math.max(
            (error.reason === 'daily_budget' && !error.retryAfterSeconds
              ? 86400
              : error.retryAfterSeconds) * 1000,
            Math.min(3600000, 2000 * 2 ** Math.min(row.attempts, 10)),
          ) + Math.floor(Math.random() * 1000);
        await this.prisma.$transaction(async (tx) => {
          await tx.commsUniOutbox.update({
            where: { id },
            data: {
              state: 'RETRY',
              ...(row.method === 'POST' && !hadPriorAttempt && rejectedBeforeMutation
                ? { firstAttemptAt: null }
                : {}),
              nextAttemptAt: new Date(Date.now() + delay),
              errorCode: error.code,
            },
          });
          if (row.commentId)
            await tx.comment.updateMany({
              where: { id: row.commentId },
              data: { commsUniState: 'RETRY' },
            });
        });
      } else {
        await this.state(
          row,
          error instanceof UnmappedConversation ? 'BLOCKED_MAPPING' : 'FAILED',
          error instanceof CommsUniError
            ? error.code
            : error instanceof UnmappedConversation
              ? error.reason
              : 'validation_or_mapping_failed',
        );
      }
    }
  }

  private async state(row: CommsUniOutbox, state: string, errorCode: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.commsUniOutbox.update({
        where: { id: row.id },
        data: {
          state,
          errorCode,
          ...(state === 'WAITING_PARENT' ? { nextAttemptAt: new Date(Date.now() + 30000) } : {}),
        },
      });
      if (row.commentId)
        await tx.comment.updateMany({
          where: { id: row.commentId },
          data: { commsUniState: state },
        });
    });
  }
}
