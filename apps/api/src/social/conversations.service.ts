import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import type {
  CommentDto,
  CommentSort,
  ConversationItemDto,
  ConversationPageDto,
  ConversationType,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { CommsUniClient, CommsUniError, UUID } from '../commsuni/commsuni.client';
import { CommsUniReadService, tvtimeUuid } from '../commsuni/commsuni.read.service';
import {
  CommsUniResolver,
  type ResolvedConversation,
  UnmappedConversation,
} from '../commsuni/commsuni.resolver';
import { ExternalReviewsService } from '../media-metadata/external-reviews.service';
import { CommentsService } from './comments.service';

interface LocalCandidate {
  id: string;
  createdAt: string;
  likesCount: number;
  sharedId: string | null;
  source?: string | null;
  userId?: string;
  sharedState?: string | null;
  preferRemote?: boolean;
  hasLocalRevision?: boolean;
  review?: CommentDto;
}
interface Session {
  version: 3;
  previousCursor?: string;
  threadType: ConversationType;
  threadId: string;
  sort: CommentSort;
  parentId?: string;
  source?: string;
  local: LocalCandidate[];
  localAfter?: { at: string; id: string; likes: number };
  localDone: boolean;
  localParents: string[];
  reviews: LocalCandidate[];
  remote: ConversationItemDto[];
  remoteCursor?: string;
  remoteDone: boolean;
  seen: string[];
  target: ResolvedConversation | null;
  upstream: ConversationPageDto['upstream'];
}
const size = 20;

@Injectable()
export class ConversationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly comments: CommentsService,
    private readonly reviews: ExternalReviewsService,
    private readonly client: CommsUniClient,
    private readonly resolver: CommsUniResolver,
    private readonly reads: CommsUniReadService,
  ) {}

  private key(userId: string, cursor: string) {
    return 'commsuni:session:' + this.client.scope + ':' + userId + ':' + cursor;
  }

  private compare(a: LocalCandidate, b: LocalCandidate, sort: CommentSort) {
    return (
      (sort === 'MOST_LIKED' ? b.likesCount - a.likesCount : 0) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.id.localeCompare(b.id)
    );
  }

  private canEmitBeforeNextLocal(session: Session): boolean {
    if (!session.localAfter) return false;
    const boundary: LocalCandidate = {
      id: session.localAfter.id,
      createdAt: session.localAfter.at,
      likesCount: session.localAfter.likes,
      sharedId: null,
    };
    const remote = session.remote[0];
    const heads = [
      session.reviews[0],
      remote?.kind === 'commsuni'
        ? {
            id: remote.comment.id,
            createdAt: remote.comment.createdAt ?? '',
            likesCount: remote.comment.likeCount,
            sharedId: remote.comment.id,
          }
        : undefined,
    ].filter((value): value is LocalCandidate => !!value);
    // The SQL stream guarantees that unseen local rows rank after this boundary.
    return heads.some((head) => this.compare(head, boundary, session.sort) <= 0);
  }

  private async loadLocal(userId: string, session: Session, blockedUsers: Set<string>) {
    const after = session.localAfter;
    const orderAfter = after
      ? {
          OR: [
            ...(session.sort === 'MOST_LIKED' ? [{ likesCount: { lt: after.likes } }] : []),
            {
              ...(session.sort === 'MOST_LIKED' ? { likesCount: after.likes } : {}),
              OR: [
                { createdAt: { lt: new Date(after.at) } },
                { createdAt: new Date(after.at), id: { gt: after.id } },
              ],
            },
          ],
        }
      : {};
    const healthy = session.upstream === 'available' && session.source !== '__local__';
    const rows = await this.prisma.comment.findMany({
      where: {
        threadType: session.threadType,
        threadId: session.threadId,
        hidden: false,
        adminDeleted: false,
        userId: { notIn: [...blockedUsers] },
        AND: [
          session.parentId
            ? {
                OR: [
                  { parentId: { in: session.localParents } },
                  { commsUniParentId: session.parentId },
                ],
              }
            : { parentId: null, externalReviewId: null, commsUniParentId: null },
          orderAfter,
          ...(healthy
            ? [
                {
                  OR: [
                    { hasLocalRevision: true },
                    { commsUniCommentId: null },
                    { commsUniEntityId: null },
                    { commsUniEntityId: { not: session.target!.entityId } },
                  ],
                },
              ]
            : []),
        ],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        sourceKey: true,
        createdAt: true,
        likesCount: true,
        commsUniCommentId: true,
        commsUniEntityId: true,
        commsUniOriginId: true,
        commsUniState: true,
        hasLocalRevision: true,
      },
      orderBy: [
        ...(session.sort === 'MOST_LIKED' ? [{ likesCount: 'desc' as const }] : []),
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      take: size + 1,
    });
    const page = rows.slice(0, size);
    session.localDone = rows.length <= size;
    const last = page.at(-1);
    if (last)
      session.localAfter = {
        at: last.createdAt.toISOString(),
        id: last.id,
        likes: last.likesCount,
      };
    const originIds = [
      ...new Set(page.flatMap((row) => (row.commsUniOriginId ? [row.commsUniOriginId] : []))),
    ];
    const originals = originIds.length
      ? await this.prisma.comment.findMany({
          where: { id: { in: originIds } },
          select: { id: true, commsUniCommentId: true, commsUniEntityId: true },
        })
      : [];
    const byOrigin = new Map(originals.map((row) => [row.id, row]));
    const candidates: LocalCandidate[] = page.map((row) => {
      const origin = row.commsUniOriginId ? byOrigin.get(row.commsUniOriginId) : undefined;
      const published = [row, origin].find(
        (value) => value?.commsUniEntityId === session.target?.entityId && value?.commsUniCommentId,
      );
      return {
        id: row.id,
        userId: row.userId,
        source: row.source,
        sharedState: row.commsUniState,
        createdAt: row.createdAt.toISOString(),
        likesCount: row.likesCount,
        // An edited import/copy is a separate local item. It must never replace
        // somebody else's archive comment based on an untrusted imported UUID.
        sharedId:
          row.hasLocalRevision && (!row.commsUniCommentId || row.source !== 'MANUAL')
            ? null
            : (published?.commsUniCommentId ?? tvtimeUuid(row.source, row.sourceKey)),
        preferRemote: !row.hasLocalRevision && !!published,
        hasLocalRevision: row.hasLocalRevision,
      };
    });
    if (healthy && session.target?.entityId) {
      const importedIds = [
        ...new Set(
          candidates.flatMap((row) =>
            row.sharedId && !row.preferRemote && !row.hasLocalRevision ? [row.sharedId] : [],
          ),
        ),
      ];
      if (importedIds.length) {
        try {
          // Verify exact imported UUIDs within this entity. These are reads, never backfill candidates.
          await this.reads.commentsByIds(userId, session.target, importedIds);
          for (const row of candidates)
            if (row.sharedId && !row.hasLocalRevision) row.preferRemote = true;
        } catch (error) {
          if (error instanceof CommsUniError && error.code === 'comment_entity_mismatch') {
            // A structural copy can belong to another archive conversation. Keep it local,
            // without claiming the wrong provider identity.
            for (const row of candidates) if (!row.preferRemote) row.sharedId = null;
          } else {
            session.upstream = 'unavailable';
            session.remoteDone = true;
            session.localAfter = undefined;
            session.localDone = false;
          }
        }
      }
    }
    session.local = candidates.filter(
      (row) => !(row.preferRemote && session.upstream === 'available'),
    );
  }

  async page(
    userId: string,
    threadType: ConversationType,
    rawId: string,
    sort: CommentSort,
    cursor?: string,
    parentId?: string,
    source?: string,
  ): Promise<ConversationPageDto> {
    let session: Session;
    if (source && source !== '__local__' && !(await this.reads.sources(userId)).has(source))
      throw new BadRequestException('Unknown conversation source');
    if (cursor) {
      if (!UUID.test(cursor)) throw new BadRequestException('Invalid conversation cursor');
      const saved = await this.redis.get<Session>(this.key(userId, cursor));
      if (
        !saved ||
        saved.version !== 3 ||
        saved.threadType !== threadType ||
        saved.sort !== sort ||
        saved.parentId !== parentId ||
        saved.source !== source
      )
        throw new BadRequestException('Conversation cursor expired');
      const currentId = await this.resolver.canonicalThread(threadType, rawId);
      if (saved.threadId !== currentId)
        throw new BadRequestException('Conversation mapping changed');
      if (saved.target) {
        const current = await this.resolver.resolve(userId, threadType, currentId);
        if (
          current.fingerprint !== saved.target.fingerprint ||
          current.reference !== saved.target.reference ||
          current.entityId !== saved.target.entityId
        )
          throw new BadRequestException('Conversation mapping changed');
      }
      session = saved;
    } else {
      const threadId = await this.resolver.canonicalThread(threadType, rawId);
      let target: ResolvedConversation | null = null;
      let upstream: Session['upstream'] = 'disabled';
      if (this.client.enabled) {
        try {
          target = await this.resolver.resolve(userId, threadType, threadId);
          upstream = target.entityId ? 'available' : 'empty';
        } catch (error) {
          upstream =
            error instanceof UnmappedConversation
              ? 'unmapped'
              : error instanceof CommsUniError &&
                  ['actor_rate', 'actor_denied'].includes(error.reason ?? '')
                ? 'throttled'
                : 'unavailable';
        }
      }
      let parents: string[] = [];
      if (parentId) {
        if (!target?.entityId) throw new BadRequestException('Shared conversation is unavailable');
        await this.reads.comment(userId, target, parentId);
        parents = (
          await this.prisma.comment.findMany({
            where: {
              threadType,
              threadId,
              OR: [
                { commsUniCommentId: parentId },
                { source: 'TVTIME', sourceKey: 'tvtime|' + parentId },
              ],
            },
            select: { id: true },
          })
        ).map((row) => row.id);
      }
      const localReviews: LocalCandidate[] = [];
      if (!parentId) {
        await this.reviews.ensureFreshForThread(threadType, threadId).catch(() => undefined);
        for (const review of await this.comments.reviewPseudoItems(userId, threadType, threadId))
          localReviews.push({
            id: review.id,
            createdAt: review.createdAt,
            likesCount: review.likesCount,
            sharedId: null,
            review: review as unknown as CommentDto,
          });
      }
      localReviews.sort((a, b) => this.compare(a, b, sort));
      session = {
        version: 3,
        threadType,
        threadId,
        sort,
        parentId,
        source,
        local: [],
        localDone: false,
        localParents: parents,
        reviews: localReviews,
        remote: [],
        remoteDone: !target?.entityId || source === '__local__',
        seen: [],
        target,
        upstream,
      };
    }
    const result: ConversationItemDto[] = [];
    const picked: LocalCandidate[] = [];
    const seen = new Set(session.seen);
    let remoteFetches = 0;
    let localFetches = 0;
    const blocked = await this.reads.blockedIdentities(userId);
    const blockedRemote = blocked.authorIds;
    const blockedUsers = blocked.userIds;
    const moderated = await this.prisma.commsUniReport.findMany({
      where: {
        scope: this.client.scope,
        state: 'HIDDEN',
        entityId: session.target?.entityId ?? '',
      },
      select: { commentId: true },
    });
    const suppressed = new Set(moderated.map((row) => row.commentId));
    if (cursor && session.remote.length) {
      const removed = await this.prisma.comment.findMany({
        where: {
          commsUniCommentId: {
            in: session.remote.flatMap((row) => (row.kind === 'commsuni' ? [row.comment.id] : [])),
          },
          OR: [{ deletedByUser: true }, { hidden: true }, { adminDeleted: true }],
        },
        select: { commsUniCommentId: true, deletedByUser: true, hidden: true, adminDeleted: true },
      });
      const byId = new Map(removed.map((row) => [row.commsUniCommentId, row]));
      session.remote = session.remote.flatMap<ConversationItemDto>((row) => {
        if (row.kind !== 'commsuni') return [row];
        const gone = byId.get(row.comment.id);
        if (!gone) return [row];
        if (gone.hidden || gone.adminDeleted || !row.comment.replyCount) return [];
        return [
          {
            ...row,
            comment: {
              ...row.comment,
              deleted: true,
              text: null,
              media: null,
              mentions: [],
              author: { id: '', displayName: '', avatarUrl: null },
              actions: {
                like: false,
                reply: false,
                delete: false,
                spoiler: false,
                authorSpoiler: false,
              },
            },
          },
        ];
      });
    }
    // Keep at most a page of remote rows. This is a cursor buffer, not a durable mirror.
    while (result.length + picked.length < size) {
      if (!session.remote.length && !session.remoteDone) {
        if (remoteFetches >= 2) break;
        remoteFetches++;
        try {
          const page = await this.reads.comments(
            userId,
            session.target!,
            sort,
            session.remoteCursor,
            parentId,
            source,
          );
          session.remote = page.comments.map((comment) => ({
            kind: 'commsuni',
            key: 'commsuni:' + comment.id,
            comment,
          }));
          session.remoteCursor = page.nextCursor ?? undefined;
          session.remoteDone = !page.nextCursor;
        } catch (error) {
          session.upstream =
            error instanceof CommsUniError &&
            ['actor_rate', 'actor_denied', 'unknown_actor_rate', 'unknown_actor_denied'].includes(
              error.reason ?? '',
            )
              ? 'throttled'
              : 'unavailable';
          session.remoteDone = true;
          // Revisit linked local rows skipped while the provider was healthy.
          session.localAfter = undefined;
          session.local = [];
          session.localDone = false;
        }
        if (!session.remote.length && !session.remoteDone) continue;
      }
      while (
        !session.local.length &&
        !session.localDone &&
        !this.canEmitBeforeNextLocal(session) &&
        localFetches < 5
      ) {
        localFetches++;
        await this.loadLocal(userId, session, blockedUsers);
      }
      if (!session.local.length && !session.localDone && !this.canEmitBeforeNextLocal(session))
        break;
      const localHead = session.local[0];
      const reviewHead = session.reviews[0];
      const useReview =
        !!reviewHead && (!localHead || this.compare(reviewHead, localHead, sort) <= 0);
      const local = useReview ? reviewHead : localHead;
      const remote = session.remote[0];
      if (!local && !remote) break;
      if (
        remote?.kind === 'commsuni' &&
        (blockedRemote.has(remote.comment.author.id) || suppressed.has(remote.comment.id))
      ) {
        session.remote.shift();
        continue;
      }
      const remoteCount = remote?.kind === 'commsuni' ? remote.comment.likeCount : 0;
      const remoteTime =
        remote?.kind === 'commsuni' ? Date.parse(remote.comment.createdAt ?? '') : NaN;
      const useRemote =
        !!remote &&
        (!local ||
          (sort === 'MOST_LIKED'
            ? remoteCount >= local.likesCount
            : !Number.isFinite(remoteTime) || remoteTime >= Date.parse(local.createdAt)));
      if (useRemote) {
        session.remote.shift();
        if (!seen.has(remote.key)) {
          seen.add(remote.key);
          result.push(remote);
        }
      } else if (local) {
        if (useReview) session.reviews.shift();
        else session.local.shift();
        if (
          (local.userId && blockedUsers.has(local.userId)) ||
          (local.sharedId && suppressed.has(local.sharedId))
        )
          continue;
        if (local.sharedId && (blockedRemote.size || (source && source !== '__local__'))) {
          try {
            const shared = await this.reads.comment(userId, session.target!, local.sharedId);
            if (
              !shared ||
              blockedRemote.has(shared.author.id) ||
              (source && shared.origin.slug !== source)
            )
              continue;
          } catch {
            continue;
          }
        }
        if (source && source !== '__local__' && !local.sharedId) continue;
        if (source === '__local__' && (local.sharedId || local.sharedState)) continue;
        const identity = local.sharedId ? 'commsuni:' + local.sharedId : 'local:' + local.id;
        if (!seen.has(identity)) {
          seen.add(identity);
          picked.push(local);
        }
      }
    }
    const { comments: localDtos, revisions } = await this.comments.conversationBatch(
      userId,
      picked.filter((row) => !row.review).map((row) => row.id),
      {
        threadType,
        threadId: session.threadId,
        ids: result.flatMap((item) => (item.kind === 'commsuni' ? [item.comment.id] : [])),
      },
    );
    const byId = new Map(localDtos.map((row) => [row.id, row as unknown as CommentDto]));
    // Reconstruct the merge order using the ordered identity list, never sort an upstream page.
    const all = new Map<string, ConversationItemDto>(result.map((item) => [item.key, item]));
    for (const row of picked) {
      const comment = row.review ?? byId.get(row.id);
      if (comment)
        all.set(row.sharedId ? 'commsuni:' + row.sharedId : 'local:' + row.id, {
          kind: 'local',
          sharedCopy: !!row.sharedId,
          localSource: row.source,
          key: 'local:' + row.id,
          comment:
            row.hasLocalRevision && row.sharedId
              ? { ...comment, commsUniCommentId: row.sharedId }
              : comment,
        });
    }
    const oldSeen = new Set(session.seen);
    let items = [...seen]
      .filter((id) => !oldSeen.has(id))
      .flatMap((id) => (all.has(id) ? [all.get(id)!] : []));
    const revisionById = new Map(revisions.map((row) => [row.sharedId, row]));
    items = items.map((item) => {
      if (item.kind !== 'commsuni') return item;
      const revision = revisionById.get(item.comment.id);
      return revision
        ? {
            kind: 'local' as const,
            key: 'local:' + revision.comment.id,
            sharedCopy: true,
            localSource: revision.source,
            comment: revision.comment as unknown as CommentDto,
          }
        : item;
    });
    session.seen = [...seen];
    const hasMore =
      !session.localDone ||
      session.local.length > 0 ||
      session.reviews.length > 0 ||
      session.remote.length > 0 ||
      !session.remoteDone;
    let nextCursor: string | null = null;
    if (hasMore) {
      // A retry of the same input cursor overwrites the same successor, avoiding cache branches.
      const hash = cursor ? createHash('sha256').update(cursor).digest('hex') : null;
      nextCursor = hash
        ? hash.slice(0, 8) +
          '-' +
          hash.slice(8, 12) +
          '-4' +
          hash.slice(13, 16) +
          '-8' +
          hash.slice(17, 20) +
          '-' +
          hash.slice(20, 32)
        : randomUUID();
      await this.redis.set(
        this.key(userId, nextCursor),
        { ...session, previousCursor: cursor },
        1800,
      );
    }
    const thread =
      (
        await this.comments.threadContexts([
          { id: 'thread', threadType, threadId: session.threadId },
        ])
      ).get('thread') ?? null;
    if (session.previousCursor)
      await this.redis.del(this.key(userId, session.previousCursor)).catch(() => undefined);
    return {
      items,
      nextCursor,
      thread,
      upstream: session.upstream,
      writesEnabled: this.client.writesEnabled,
      sort,
    };
  }
}
