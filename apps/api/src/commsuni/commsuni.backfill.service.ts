import { publicCommentImageUrl } from '../comment-images/lib/public-url';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { Prisma, type Comment } from '@prisma/client';
import type {
  CommsUniBackfillRequest,
  CommsUniBackfillPreview,
  CommsUniBackfillRow,
  CommsUniBackfillApply,
  CommsUniBackfillResult,
} from './commsuni.backfill.dto';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommsUniClient, UUID } from './commsuni.client';
import { CommsUniResolver, type ResolvedConversation } from './commsuni.resolver';
import { CommsUniPublicationService } from './commsuni.publication.service';
import { object, httpsUrl, tvtimeUuid } from './commsuni.read.service';
import { validateWrite } from './commsuni.validation';

const candidateInclude = {
  image: { select: { id: true, status: true, storageKey: true } },
  user: {
    select: {
      id: true,
      username: true,
      isShadow: true,
      isSuspended: true,
      profile: { select: { displayName: true, avatarUrl: true } },
    },
  },
} satisfies Prisma.CommentInclude;
type Candidate = Prisma.CommentGetPayload<{ include: typeof candidateInclude }>;

@Injectable()
export class CommsUniBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: CommsUniClient,
    private readonly resolver: CommsUniResolver,
    private readonly publication: CommsUniPublicationService,
  ) {}

  private validateRun(runId: string, cutoff: string) {
    if (
      !UUID.test(runId) ||
      !/(Z|[+-]\d{2}:\d{2})$/i.test(cutoff) ||
      !Number.isFinite(Date.parse(cutoff)) ||
      Date.parse(cutoff) > Date.now()
    )
      throw new BadRequestException('A run UUID and fixed cutoff with timezone are required');
  }

  private exclusion(row: Candidate | null, cutoff: string): string | null {
    if (!row) return 'comment_missing';
    if (row.createdAt.getTime() > Date.parse(cutoff)) return 'after_cutoff';
    if (row.source !== 'MANUAL' || row.sourceKey) return 'imported_or_unproven_origin';
    if (row.hasLocalRevision) return 'local_revision';
    if (row.commsUniOriginId && row.commsUniOriginId !== row.id) return 'structural_copy';
    if (row.commsUniCommentId || row.commsUniState) return 'already_submitted';
    if (row.deletedByUser || row.hidden || row.adminDeleted) return 'not_visible';
    if (!row.user || row.user.isShadow || row.user.isSuspended) return 'author_unavailable';
    if (!['SHOW', 'MOVIE', 'EPISODE'].includes(row.threadType)) return 'unsupported_thread';
    if (row.externalReviewId || row.mediaId || row.listId)
      return 'unsupported_attachment_or_review';
    if (row.parentSourceKey && !row.parentId && !row.commsUniParentId) return 'unresolved_parent';
    return null;
  }

  private async provenanceExclusion(
    db: Prisma.TransactionClient,
    row: Candidate,
  ): Promise<string | null> {
    if (
      await db.importAppliedRecord.findFirst({
        where: { targetTable: 'comments', targetRecordId: row.id },
        select: { id: true },
      })
    )
      return 'import_audit_record';
    if (
      await db.mediaCanonicalCopy.findFirst({
        where: { entityType: 'COMMENT', targetId: row.id },
        select: { id: true },
      })
    )
      return 'structural_copy_ledger';
    // Older split copies had no lineage column or copy ledger. An identical author/action
    // timestamp on another thread is ambiguity, never evidence to merge or select a winner.
    if (
      await db.comment.findFirst({
        where: {
          id: { not: row.id },
          userId: row.userId,
          createdAt: row.createdAt,
          commsUniOriginId: null,
          OR: [{ threadType: { not: row.threadType } }, { threadId: { not: row.threadId } }],
        },
        select: { id: true },
      })
    )
      return 'ambiguous_cross_thread_origin';
    return null;
  }

  private fingerprint(
    row: Candidate,
    target: ResolvedConversation,
    runId: string,
    cutoff: string,
  ): string {
    const secret = this.config.get<string>('commsuni.actorSecret') || '';
    if (secret.length < 32)
      throw new ServiceUnavailableException('Stable actor secret is required');
    return createHmac('sha256', secret)
      .update(
        JSON.stringify({
          version: 1,
          scope: this.client.scope,
          runId,
          cutoff,
          id: row.id,
          userId: row.userId,
          threadType: row.threadType,
          threadId: row.threadId,
          parentId: row.parentId,
          parentSourceKey: row.parentSourceKey,
          remoteParent: row.commsUniParentId,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
          language: row.language,
          isSpoiler: row.isSpoiler,
          source: row.source,
          sourceKey: row.sourceKey,
          origin: row.commsUniOriginId,
          imageUrl: row.imageUrl,
          gifUrl: row.gifUrl,
          image: row.image,
          reference: target.reference,
          mapping: target.fingerprint,
        }),
      )
      .digest('hex');
  }

  private async inspect(
    row: Candidate,
    runId: string,
    cutoff: string,
  ): Promise<CommsUniBackfillRow> {
    const result: CommsUniBackfillRow = {
      commentId: row.id,
      userId: row.userId,
      threadType: row.threadType,
      threadId: row.threadId,
      parentId: row.parentId,
      createdAt: row.createdAt.toISOString(),
      status: 'excluded',
      reason: this.exclusion(row, cutoff) || '',
    };
    if (result.reason) return result;
    const provenance = await this.provenanceExclusion(this.prisma, row);
    if (provenance) return { ...result, reason: provenance };
    const existing = await this.prisma.commsUniOutbox.findUnique({
      where: { dedupeKey: 'comment:' + row.id },
      select: { id: true },
    });
    if (existing) return { ...result, reason: 'existing_operation' };
    try {
      const target = await this.resolver.resolve(row.userId, row.threadType as any, row.threadId, {
        persist: false,
      });
      if (target.threadId !== row.threadId)
        return { ...result, status: 'blocked', reason: 'canonical_thread_changed' };
      if (row.parentId) {
        const parent = await this.prisma.comment.findUnique({
          where: { id: row.parentId },
          include: candidateInclude,
        });
        if (
          !parent ||
          parent.threadType !== row.threadType ||
          parent.threadId !== row.threadId ||
          parent.hidden ||
          parent.adminDeleted ||
          parent.deletedByUser
        )
          return { ...result, status: 'blocked', reason: 'parent_unavailable' };
        if (row.createdAt < parent.createdAt)
          return { ...result, status: 'blocked', reason: 'reply_precedes_parent' };
        const remoteParent =
          parent.commsUniCommentId ?? tvtimeUuid(parent.source, parent.sourceKey);
        const queuedParent = [
          'PENDING',
          'RETRY',
          'SENDING',
          'WAITING_REVIEW',
          'WAITING_PARENT',
          'BACKFILL_PAUSED',
        ].includes(parent.commsUniState ?? '');
        if (!remoteParent && !queuedParent && this.exclusion(parent, cutoff) !== null)
          return { ...result, status: 'blocked', reason: 'parent_not_shareable' };
      }
      const payload = this.publication.commentBody(row);
      validateWrite(payload, this.config.get<string[]>('commsuni.mediaHosts') ?? []);
      const avatar = httpsUrl(row.user.profile?.avatarUrl);
      const hosts = this.config.get<string[]>('commsuni.avatarHosts') ?? [];
      return {
        ...result,
        status: 'eligible',
        reason: 'original_app_comment',
        reference: target.reference,
        proof: this.fingerprint(row, target, runId, cutoff),
        payload,
        author: {
          displayName: row.user.profile?.displayName?.trim() || row.user.username,
          avatarUrl:
            avatar && hosts.includes(new URL(avatar).hostname.toLowerCase()) ? avatar : null,
        },
      };
    } catch (error) {
      return {
        ...result,
        status: 'blocked',
        reason:
          error instanceof BadRequestException ? error.message : 'mapping_or_provider_unavailable',
      };
    }
  }

  async preview(input: CommsUniBackfillRequest): Promise<CommsUniBackfillPreview> {
    this.validateRun(input.runId, input.cutoff);
    if (
      input.limit != null &&
      (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
    )
      throw new BadRequestException('Limit must be an integer from 1 to 100');
    const limit = input.limit ?? 50;
    let cursor: { at: string; id: string } | null = null;
    if (input.cursor) {
      try {
        cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'));
        if (
          !cursor ||
          typeof cursor.id !== 'string' ||
          cursor.id.length > 128 ||
          !Number.isFinite(Date.parse(cursor.at))
        )
          throw Error();
      } catch {
        throw new BadRequestException('Invalid backfill cursor');
      }
    }
    const rows = await this.prisma.comment.findMany({
      where: {
        source: 'MANUAL',
        createdAt: { lte: new Date(input.cutoff) },
        ...(cursor
          ? {
              OR: [
                { createdAt: { gt: new Date(cursor.at), lte: new Date(input.cutoff) } },
                { createdAt: new Date(cursor.at), id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      include: candidateInclude,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const reviewed: CommsUniBackfillRow[] = [];
    for (const row of page) reviewed.push(await this.inspect(row, input.runId, input.cutoff));
    const last = page[page.length - 1];
    const sourceCounts = !input.cursor
      ? await this.prisma.comment.groupBy({
          by: ['source'],
          where: { createdAt: { lte: new Date(input.cutoff) } },
          _count: { _all: true },
        })
      : undefined;
    return {
      version: 1,
      connectionScope: this.client.scope,
      runId: input.runId,
      cutoff: input.cutoff,
      rows: reviewed,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(JSON.stringify({ at: last.createdAt.toISOString(), id: last.id })).toString(
              'base64url',
            )
          : null,
      ...(sourceCounts
        ? {
            sourceCounts: sourceCounts.map((row) => ({
              source: row.source,
              count: row._count._all,
            })),
          }
        : {}),
    };
  }

  async enqueue(input: CommsUniBackfillApply): Promise<{ results: CommsUniBackfillResult[] }> {
    this.validateRun(input.runId, input.cutoff);
    this.client.assertWrites();
    if (await this.client.writePausedUntil())
      throw new ServiceUnavailableException('Provider daily budget is paused');
    if (this.config.get('commsuni.backfillEnabled') !== true)
      throw new ServiceUnavailableException('Backfill is disabled');
    if (input.acknowledgeHistoricalSharing !== true)
      throw new BadRequestException('Historical sharing must be explicitly acknowledged');
    if (
      !Array.isArray(input.entries) ||
      !input.entries.length ||
      input.entries.length > 25 ||
      input.entries.some(
        (row) =>
          !row ||
          typeof row.commentId !== 'string' ||
          !row.commentId ||
          row.commentId.length > 128 ||
          typeof row.proof !== 'string' ||
          !/^[a-f0-9]{64}$/.test(row.proof),
      ) ||
      new Set(input.entries.map((row) => row.commentId)).size !== input.entries.length
    )
      throw new BadRequestException('Provide 1–25 distinct reviewed comments');
    const readiness = await this.readiness();
    if (readiness.missing.length)
      throw new ServiceUnavailableException(
        'Required schema/configuration is missing: ' + readiness.missing.join(', '),
      );
    const results: CommsUniBackfillResult[] = [];
    for (const entry of input.entries) {
      const existing = await this.prisma.commsUniOutbox.findUnique({
        where: { dedupeKey: 'comment:' + entry.commentId },
        include: { identity: { select: { scope: true } } },
      });
      if (existing) {
        results.push(
          existing.identity.scope === this.client.scope
            ? {
                commentId: entry.commentId,
                status: 'existing',
                operationId: existing.id,
                state: existing.state,
              }
            : { commentId: entry.commentId, status: 'blocked', reason: 'connection_scope_changed' },
        );
        continue;
      }
      const row = await this.prisma.comment.findUnique({
        where: { id: entry.commentId },
        include: candidateInclude,
      });
      if (!row) {
        results.push({ commentId: entry.commentId, status: 'blocked', reason: 'comment_missing' });
        continue;
      }
      const review = await this.inspect(row, input.runId, input.cutoff);
      if (
        review.status !== 'eligible' ||
        !review.proof ||
        !/^[a-f0-9]{64}$/.test(entry.proof) ||
        !timingSafeEqual(Buffer.from(entry.proof, 'hex'), Buffer.from(review.proof, 'hex'))
      ) {
        results.push({
          commentId: entry.commentId,
          status: 'blocked',
          reason: review.status === 'eligible' ? 'preview_changed' : review.reason,
        });
        continue;
      }
      const target = await this.resolver.resolve(row.userId, row.threadType as any, row.threadId, {
        persist: false,
      });
      try {
        const result = await this.prisma.$transaction(async (tx) => {
          // Bound the historical backlog across concurrent operators and API replicas.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${this.client.scope + ':backfill-admission'}))`;
          const pending = await tx.commsUniOutbox.count({
            where: {
              identity: { scope: this.client.scope },
              target: { path: ['backfill', 'runId'], string_contains: '-' },
              state: {
                notIn: [
                  'SYNCED',
                  'DUPLICATE_REPORT',
                  'CANCELED',
                  'FAILED',
                  'UNCERTAIN',
                  'BLOCKED_MAPPING',
                  'BLOCKED_PARENT',
                ],
              },
            },
          });
          if (pending >= 100)
            return {
              commentId: row.id,
              status: 'deferred',
              reason: 'backfill_queue_full',
            } as CommsUniBackfillResult;
          await tx.$queryRaw`SELECT id FROM comments WHERE id = ${row.id} FOR UPDATE`;
          const current = await tx.comment.findUnique({
            where: { id: row.id },
            include: candidateInclude,
          });
          if (
            !current ||
            this.exclusion(current, input.cutoff) ||
            this.fingerprint(current, target, input.runId, input.cutoff) !== review.proof
          )
            return {
              commentId: row.id,
              status: 'blocked',
              reason: 'preview_changed',
            } as CommsUniBackfillResult;
          const provenance = await this.provenanceExclusion(tx, current);
          if (provenance)
            return {
              commentId: row.id,
              status: 'blocked',
              reason: provenance,
            } as CommsUniBackfillResult;
          if (current.parentId) {
            const parent = await tx.comment.findUnique({ where: { id: current.parentId } });
            if (
              !parent ||
              parent.deletedByUser ||
              parent.hidden ||
              parent.adminDeleted ||
              parent.threadType !== current.threadType ||
              parent.threadId !== current.threadId ||
              parent.createdAt > current.createdAt
            )
              return {
                commentId: row.id,
                status: 'blocked',
                reason: 'parent_unavailable',
              } as CommsUniBackfillResult;
            if (
              !parent.commsUniCommentId &&
              !parent.commsUniState &&
              !tvtimeUuid(parent.source, parent.sourceKey)
            )
              return {
                commentId: row.id,
                status: 'deferred',
                reason: 'enqueue_parent_first',
              } as CommsUniBackfillResult;
          }
          await this.publication.capture(
            tx,
            current.userId,
            current,
            false,
            undefined,
            { runId: input.runId, cutoff: input.cutoff },
            target,
          );
          const operation = await tx.commsUniOutbox.findUnique({
            where: { dedupeKey: 'comment:' + current.id },
          });
          if (!operation) throw new BadRequestException('Comment did not pass publication guards');
          return {
            commentId: row.id,
            status: 'queued',
            operationId: operation.id,
            state: operation.state,
          } as CommsUniBackfillResult;
        });
        results.push(result);
      } catch (error) {
        // A competing enqueue can win the same permanent dedupe key. Never create a replacement key.
        if ((error as { code?: string }).code === 'P2002') {
          const operation = await this.prisma.commsUniOutbox.findUnique({
            where: { dedupeKey: 'comment:' + row.id },
          });
          if (operation) {
            results.push({
              commentId: row.id,
              status: 'existing',
              operationId: operation.id,
              state: operation.state,
            });
            continue;
          }
        }
        results.push({ commentId: row.id, status: 'blocked', reason: 'enqueue_failed' });
      }
    }
    return { results };
  }

  async readiness() {
    const missing: string[] = [];
    const schema = await this.prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name IN ('commsuni_outbox','commsuni_vote_receipts','user_episode_status','user_movie_status','comments','comment_images')`;
    const has = (table: string, column: string) =>
      schema.some((row) => row.table_name === table && row.column_name === column);
    if (!has('commsuni_outbox', 'sequence')) missing.push('delivery_ordering_migration');
    if (!has('commsuni_vote_receipts', 'selected_keys')) missing.push('vote_receipts_migration');
    if (!has('user_episode_status', 'device_source') || !has('user_movie_status', 'device_source'))
      missing.push('device_provenance_migration');
    if (
      !has('comments', 'has_local_revision') ||
      !has('comments', 'client_request_hash') ||
      !has('comment_images', 'retained_comment_id')
    )
      missing.push('mobile_compatibility_migration');
    if (!this.client.enabled) missing.push('provider_read_configuration');
    if (!this.client.sourceSlug) missing.push('registered_source_slug');
    let imageUrl: string | null = null;
    try {
      imageUrl = publicCommentImageUrl(this.config, 'IMAGE_ID');
    } catch {
      /* text-only is supported */
    }
    return {
      images: {
        deliveryUrlExample: imageUrl,
        configuredHostAllowed:
          !!imageUrl &&
          (this.config.get<string[]>('commsuni.mediaHosts') ?? []).includes(
            new URL(imageUrl).hostname.toLowerCase(),
          ),
        // Configuration cannot establish operator registration or external reachability.
        operatorRegistrationVerified: false,
      },
      connectionScope: this.client.scope,
      writesEnabled: this.client.writesEnabled,
      writePausedUntil: await this.client.writePausedUntil(),
      backfillEnabled: this.config.get('commsuni.backfillEnabled') === true,
      automaticModerationConfigured: !!this.config.get('commentImages.openaiApiKey'),
      missing,
    };
  }

  async report(runId: string, cursor?: string) {
    if (cursor && !/^\d{1,30}$/.test(cursor))
      throw new BadRequestException('Invalid report cursor');
    if (!UUID.test(runId)) throw new BadRequestException('Invalid run ID');
    const where = {
      identity: { scope: this.client.scope },
      target: { path: ['backfill', 'runId'], equals: runId },
    };
    const [states, operations] = await Promise.all([
      this.prisma.commsUniOutbox.groupBy({ by: ['state'], where, _count: { _all: true } }),
      this.prisma.commsUniOutbox.findMany({
        where: { ...where, ...(cursor ? { sequence: { gt: BigInt(cursor) } } : {}) },
        orderBy: { sequence: 'asc' },
        take: 101,
        select: {
          id: true,
          sequence: true,
          commentId: true,
          state: true,
          remoteId: true,
          errorCode: true,
          target: true,
        },
      }),
    ]);
    return {
      runId,
      writePausedUntil: await this.client.writePausedUntil(),
      states: states.map((row) => ({ state: row.state, count: row._count._all })),
      nextCursor: operations.length > 100 ? operations[99].sequence.toString() : null,
      operations: operations.slice(0, 100).map(({ target, sequence, ...row }) => ({
        sequence: sequence.toString(),
        ...row,
        diagnostic: object(object(target).lastError),
      })),
    };
  }
}
