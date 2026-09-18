import { localCommentCountQuery } from './commsuni.comment-count.sql';
import { tvtimeUuid } from './commsuni.comment-identity';
export { tvtimeUuid } from './commsuni.comment-identity';
import { mapCastOptions, deviceValue } from './commsuni.option-mapping';
import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  CommsUniCommentDto,
  CommsUniEngagementDto,
  CommsUniEngagementKind,
  CommsUniOptionDto,
  CommsUniOrigin,
  ConversationType,
} from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommsUniClient, CommsUniError, UUID, entityCacheResources } from './commsuni.client';
import { CommsUniResolver, type ResolvedConversation } from './commsuni.resolver';

export type JsonObject = Record<string, unknown>;
export const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

export function decodeComment(
  raw: unknown,
  entityId: string,
  sources: Map<string, CommsUniOrigin>,
  writable: boolean,
  ownAuthorId: string | null,
  canReplyLocally = writable,
): CommsUniCommentDto | null {
  const row = object(raw);
  if (row.entityId !== entityId || !UUID.test(String(row.id)))
    throw new CommsUniError(502, 'comment_entity_mismatch');
  const deleted = row.deleted === true || !!row.deletedAt;
  if (deleted && count(row.replyCount) === 0) return null;
  const origin = object(row.origin);
  const slug = str(origin.slug) ?? 'unknown';
  const own = origin.kind === 'partner' && row.userId === ownAuthorId;
  const source: CommsUniOrigin = sources.get(slug) ?? {
    slug,
    kind: origin.kind === 'tvtime' || origin.kind === 'partner' ? origin.kind : 'unknown',
    displayName: str(origin.displayName) ?? slug,
    iconUrl: null,
  };
  const media = object(row.media);
  let attachment: CommsUniCommentDto['media'] = null;
  if (media.kind === 'archive')
    attachment = {
      kind: 'archive',
      ...(str(media.contentType) ? { contentType: str(media.contentType)! } : {}),
    };
  if (media.kind === 'external') {
    const url = httpsUrl(media.url);
    if (url) attachment = { kind: 'external', url };
  }
  if (
    attachment &&
    typeof media.width === 'number' &&
    typeof media.height === 'number' &&
    Number.isFinite(media.width) &&
    Number.isFinite(media.height) &&
    media.width > 0 &&
    media.height > 0
  ) {
    attachment.width = media.width;
    attachment.height = media.height;
  }
  const created = str(row.createdAt);
  const result: CommsUniCommentDto = {
    id: String(row.id),
    entityId,
    origin: source,
    text: str(row.text),
    createdAt: created && Number.isFinite(Date.parse(created)) ? created : null,
    author: {
      id: str(row.userId) ?? '',
      displayName: str(row.userName) ?? source.displayName,
      avatarUrl: httpsUrl(row.userAvatar),
    },
    parentCommentId: str(row.parentCommentId),
    inReplyToCommentId: str(row.inReplyToCommentId),
    rootCommentId: str(row.rootCommentId) ?? String(row.id),
    depth: Math.min(2, count(row.depth)),
    likeCount: count(row.likeCount),
    replyCount: count(row.replyCount),
    spoilerCount: count(row.spoilerCount),
    isSpoiler: row.isSpoiler === true,
    rating:
      typeof row.rating === 'number' && row.rating >= 0 && row.rating <= 10 ? row.rating : null,
    language: str(row.language),
    media: attachment,
    mentions: (Array.isArray(row.mentions) ? row.mentions : []).map((value) => {
      const mention = object(value);
      return {
        userId: str(mention.userId),
        userName: str(mention.userName) ?? '',
        start: typeof mention.start === 'number' ? mention.start : null,
        end: typeof mention.end === 'number' ? mention.end : null,
      };
    }),
    actions: {
      like: writable,
      // Creating a local reply is independent from publishing it to the provider.
      reply: canReplyLocally,
      delete: writable && own,
      spoiler: writable && !own,
      authorSpoiler: writable && own,
    },
  };
  if (deleted) {
    // Keep only the thread structure needed to reach surviving replies.
    return {
      ...result,
      deleted: true,
      text: null,
      media: null,
      mentions: [],
      rating: null,
      author: { id: '', displayName: '', avatarUrl: null },
      createdAt: null,
      likeCount: 0,
      spoilerCount: 0,
      isSpoiler: false,
      actions: { like: false, reply: false, delete: false, spoiler: false, authorSpoiler: false },
    };
  }
  if (typeof row.viewerLiked === 'boolean') result.viewerLiked = row.viewerLiked;
  if (typeof row.viewerMarkedSpoiler === 'boolean')
    result.viewerMarkedSpoiler = row.viewerMarkedSpoiler;
  return result;
}

const SECTION_FIELDS: [CommsUniEngagementKind, string][] = [
  ['star_rating', 'starRatings'],
  ['emotion', 'emotions'],
  ['cast_vote', 'castVotes'],
  ['watch_device', 'watchedOnDevices'],
  ['watch_platform', 'watchedOnPlatforms'],
  ['movie_interest', 'movieInterests'],
];
const STAR_KEYS: Record<string, string> = {
  'rating:1': '1',
  'rating:27': '2',
  'rating:28': '3',
  'rating:29': '4',
  'rating:3': '5',
};
const EMOTION_KEYS = [
  'SHOCKED',
  'FRUSTRATED',
  'SAD',
  'REFLECTIVE',
  'TOUCHED',
  'AMUSED',
  'SCARED',
  'BORED',
  'UNDERSTANDING',
  'THRILLED',
  'CONFUSED',
  'TENSE',
];

export function fixedOptionKey(kind: string, value: string | null): string | null {
  if (kind === 'star_rating')
    return Object.keys(STAR_KEYS).find((key) => STAR_KEYS[key] === value) ?? null;
  if (kind === 'emotion' && value) {
    const index = EMOTION_KEYS.indexOf(value);
    return index < 0 ? null : 'emotion:' + (index + 28);
  }
  return null;
}

export function decodeEngagement(
  raw: unknown,
  target: ResolvedConversation,
  writable: boolean,
): CommsUniEngagementDto {
  const data = object(raw);
  const entity = object(data.entity);
  if (entity.id !== target.entityId || entity.type !== target.entityType)
    throw new CommsUniError(502, 'engagement_entity_mismatch');
  const options = object(data.options);
  const rating = object(data.rating);
  return {
    available: true,
    entity: { type: target.entityType, id: target.entityId!, reference: target.reference },
    writesEnabled: writable,
    rating: {
      average: typeof rating.average === 'number' ? rating.average : null,
      count: count(rating.count),
      viewerRating: typeof rating.viewerRating === 'number' ? rating.viewerRating : null,
    },
    sections: SECTION_FIELDS.map(([kind, field]) => ({
      kind,
      options: (Array.isArray(options[field]) ? (options[field] as unknown[]) : []).flatMap(
        (value): CommsUniOptionDto[] => {
          const item = object(value);
          if (typeof item.key !== 'string' || !item.key || item.key.length > 256) return [];
          let localValue: string | null = null;
          if (
            kind === 'star_rating' &&
            STAR_KEYS[item.key] &&
            (item.stars == null || String(item.stars) === STAR_KEYS[item.key])
          )
            localValue = STAR_KEYS[item.key];
          if (kind === 'emotion' && /^emotion:(2[89]|3[0-9])$/.test(item.key))
            localValue = EMOTION_KEYS[Number(item.key.split(':')[1]) - 28] ?? null;
          if (kind === 'watch_device') localValue = deviceValue(item.key, item.id, item.name);
          const votes = object(item.votes);
          const splitValid =
            Number.isSafeInteger(votes.archived) &&
            Number(votes.archived) >= 0 &&
            Number.isSafeInteger(votes.native) &&
            Number(votes.native) >= 0 &&
            Number(votes.archived) + Number(votes.native) === item.count;
          return [
            {
              key: item.key,
              label:
                str(item.label) ??
                str(item.name) ??
                str(item.characterName) ??
                str(item.actorName) ??
                item.key,
              count: count(item.count),
              ...(splitValid
                ? { archivedCount: Number(votes.archived), nativeCount: Number(votes.native) }
                : {}),
              ...(kind === 'cast_vote' ? { role: str(item.role) ?? str(item.characterName) } : {}),
              selected: item.viewerSelected === true,
              imageUrl: httpsUrl(item.imageUrl) ?? httpsUrl(item.image),
              localValue,
            },
          ];
        },
      ),
    })),
  };
}

@Injectable()
export class CommsUniReadService {
  constructor(
    private readonly client: CommsUniClient,
    private readonly resolver: CommsUniResolver,
    private readonly prisma: PrismaService,
  ) {}

  async blockedIdentities(userId: string) {
    const [remote, local] = await Promise.all([
      this.prisma.commsUniAuthorBlock.findMany({
        where: { userId, scope: this.client.scope },
        select: { authorId: true },
      }),
      this.prisma.block.findMany({ where: { blockerId: userId }, select: { blockedId: true } }),
    ]);
    const authorIds = new Set(remote.map((row) => row.authorId));
    const userIds = new Set(local.map((row) => row.blockedId));
    if (authorIds.size || userIds.size) {
      // These are explicit publication links, never guesses about people across apps.
      const links = await this.prisma.commsUniIdentity.findMany({
        where: {
          scope: this.client.scope,
          OR: [{ authorId: { in: [...authorIds] } }, { userId: { in: [...userIds] } }],
        },
        select: { authorId: true, userId: true },
      });
      for (const link of links) {
        if (link.authorId) authorIds.add(link.authorId);
        if (link.userId) userIds.add(link.userId);
      }
    }
    return { authorIds, userIds };
  }

  async sources(userId: string): Promise<Map<string, CommsUniOrigin>> {
    const data = await this.client.read<unknown>(userId, '/sources', {}, 3600);
    return new Map(
      (Array.isArray(data) ? data : []).flatMap((raw) => {
        const row = object(raw);
        if (typeof row.slug !== 'string') return [];
        return [
          [
            row.slug,
            {
              slug: row.slug,
              sourceId: typeof row.source_id === 'number' ? row.source_id : undefined,
              displayName: str(row.displayName) ?? row.slug,
              kind: row.kind === 'tvtime' || row.kind === 'partner' ? row.kind : 'unknown',
              iconUrl: httpsUrl(row.iconUrl),
            } as CommsUniOrigin,
          ] as const,
        ];
      }),
    );
  }

  private async viewer(userId: string) {
    const [identity, user] = await Promise.all([
      this.prisma.commsUniIdentity.findUnique({
        where: { userId_scope: { userId, scope: this.client.scope } },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { isSuspended: true, isShadow: true },
      }),
    ]);
    const canReplyLocally = !!user && !user.isSuspended && !user.isShadow && !identity?.deleting;
    return {
      authorId: identity?.authorId ?? null,
      canReplyLocally,
      writable: this.client.writesEnabled && canReplyLocally,
    };
  }

  async context(userId: string) {
    const [sources, viewer, blocked] = await Promise.all([
      this.sources(userId),
      this.viewer(userId),
      this.blockedIdentities(userId),
    ]);
    return { sources, viewer, blocked };
  }

  private async visibleComments(
    userId: string,
    target: ResolvedConversation,
    rows: unknown[],
    context: Awaited<ReturnType<CommsUniReadService['context']>>,
  ): Promise<CommsUniCommentDto[]> {
    const ids = rows.map((row) => String(object(row).id));
    const [removed, moderated] = await Promise.all([
      this.prisma.comment.findMany({
        where: {
          commsUniCommentId: { in: ids },
          OR: [
            { deletedByUser: true },
            { hidden: true },
            { adminDeleted: true },
            { userId, source: 'MANUAL', commsUniEntityId: target.entityId },
          ],
        },
        select: {
          id: true,
          userId: true,
          source: true,
          commsUniEntityId: true,
          commsUniCommentId: true,
          deletedByUser: true,
          hidden: true,
          adminDeleted: true,
        },
      }),
      this.prisma.commsUniReport.findMany({
        where: { scope: this.client.scope, state: 'HIDDEN', commentId: { in: ids } },
        select: { commentId: true },
      }),
    ]);
    const localById = new Map(removed.map((row) => [row.commsUniCommentId, row]));
    const hidden = new Set(moderated.map((row) => row.commentId));
    const comments: CommsUniCommentDto[] = [];
    for (const raw of rows) {
      const value = object(raw);
      const local = localById.get(String(value.id));
      if (
        hidden.has(String(value.id)) ||
        local?.hidden ||
        local?.adminDeleted ||
        context.blocked.authorIds.has(String(value.userId))
      )
        continue;
      const decoded = decodeComment(
        local?.deletedByUser ? { ...value, deleted: true } : raw,
        target.entityId!,
        context.sources,
        context.viewer.writable,
        context.viewer.authorId,
        context.viewer.canReplyLocally,
      );
      // This durable layer contains only our source's existing rows. Never import
      // another partner's content or infer a deletion from absence on a page.
      if (
        this.client.sourceSlug &&
        object(value.origin).slug === this.client.sourceSlug &&
        object(value.origin).kind === 'partner'
      ) {
        const data = {
          likesCount: count(value.likeCount),
          spoilerCount: count(value.spoilerCount),
          isSpoiler: value.isSpoiler === true,
          ...(value.deleted === true || value.deletedAt ? { deletedByUser: true } : {}),
        };
        await this.prisma.comment.updateMany({
          where: {
            commsUniCommentId: String(value.id),
            commsUniEntityId: target.entityId,
            source: 'MANUAL',
            OR: [
              { likesCount: { not: data.likesCount } },
              { spoilerCount: { not: data.spoilerCount } },
              { isSpoiler: { not: data.isSpoiler } },
              ...(data.deletedByUser ? [{ deletedByUser: false }] : []),
            ],
          },
          data,
        });
      }
      if (decoded) {
        // Expose only this viewer's verified local copy, never match ownership by display name.
        if (
          !decoded.deleted &&
          local?.userId === userId &&
          local.source === 'MANUAL' &&
          local.commsUniEntityId === target.entityId &&
          decoded.origin.kind === 'partner' &&
          decoded.origin.slug === this.client.sourceSlug
        )
          decoded.localCommentId = local.id;
        comments.push(decoded);
      }
    }
    await this.addLocalReplyCounts(comments, target, context.blocked.userIds);
    return comments;
  }

  async comments(
    userId: string,
    target: ResolvedConversation,
    sort: 'LATEST' | 'MOST_LIKED',
    cursor?: string,
    parentId?: string,
    source?: string,
  ): Promise<{ comments: CommsUniCommentDto[]; nextCursor: string | null }> {
    if (!target.entityId) return { comments: [], nextCursor: null };
    const context = await this.context(userId);
    let path = this.resolver.path(target) + '/comments';
    const query: Record<string, string | number | undefined> = {
      sort: sort === 'MOST_LIKED' ? 'most_liked' : 'most_recent',
      limit: 20,
      cursor,
      source,
    };
    if (parentId) {
      const parent = await this.comment(userId, target, parentId, context);
      path = '/comments/' + parent.rootCommentId + '/replies';
      if (parent.depth > 0) query.parent = parent.id;
    }
    let data: JsonObject;
    const resource = entityCacheResources(target)[0];
    const readVersion = await this.client.cacheVersion(resource);
    try {
      data = object(await this.client.read(userId, path, query, 30, resource));
    } catch (error) {
      if (error instanceof CommsUniError && error.empty) return { comments: [], nextCursor: null };
      throw error;
    }
    const rows = parentId ? data.replies : data.comments;
    if (!Array.isArray(rows)) throw new CommsUniError(502, 'invalid_comment_page');
    const comments = await this.visibleComments(userId, target, rows, context);
    // Page requests never include signed URLs. Prime the exact single-comment read
    // to avoid charging another provider read for each visible image or reply.
    await Promise.all(
      rows.map(async (raw) => {
        const value = object(raw);
        if (UUID.test(String(value.id)) && value.entityId === target.entityId)
          await this.client.prime(
            userId,
            '/comments/' + value.id,
            { comment: raw },
            resource,
            readVersion,
          );
      }),
    );
    return { comments, nextCursor: data.complete === true ? null : str(data.nextCursor) };
  }

  async commentsByIds(
    userId: string,
    target: ResolvedConversation,
    ids: string[],
    context?: Awaited<ReturnType<CommsUniReadService['context']>>,
  ): Promise<CommsUniCommentDto[]> {
    if (!target.entityId || ids.some((id) => !UUID.test(id)))
      throw new NotFoundException('Comment not found');
    const viewer = context ?? (await this.context(userId));
    const rows = await Promise.all(
      ids.map(async (id) => {
        try {
          const data = await this.client.read<{ comment: unknown }>(
            userId,
            '/comments/' + id,
            {},
            30,
            entityCacheResources(target)[0],
          );
          if (String(object(data.comment).id).toLowerCase() !== id.toLowerCase())
            throw new CommsUniError(502, 'comment_id_mismatch');
          return data.comment;
        } catch (error) {
          if (
            error instanceof CommsUniError &&
            error.status === 404 &&
            error.code === 'comment_not_found'
          )
            return null;
          throw error;
        }
      }),
    );
    return this.visibleComments(
      userId,
      target,
      rows.filter((row) => row != null),
      viewer,
    );
  }

  async comment(
    userId: string,
    target: ResolvedConversation,
    id: string,
    context?: Awaited<ReturnType<CommsUniReadService['context']>>,
  ): Promise<CommsUniCommentDto> {
    const result = (await this.commentsByIds(userId, target, [id], context))[0];
    if (!result) throw new NotFoundException('Comment not found');
    return result;
  }

  /** Unpublished local replies must keep their parent's thread expandable after a reload. */
  private async addLocalReplyCounts(
    comments: CommsUniCommentDto[],
    target: ResolvedConversation,
    blockedUsers: Set<string>,
  ) {
    if (!comments.length) return;
    const local = await this.prisma.comment.groupBy({
      by: ['commsUniParentId'],
      where: {
        threadType: target.threadType,
        threadId: target.threadId,
        commsUniParentId: { in: comments.map((comment) => comment.id) },
        commsUniCommentId: null,
        source: 'MANUAL',
        hidden: false,
        adminDeleted: false,
        deletedByUser: false,
        userId: { notIn: [...blockedUsers] },
      },
      _count: { _all: true },
    });
    const counts = new Map(local.map((row) => [row.commsUniParentId, row._count._all]));
    for (const comment of comments) comment.replyCount += counts.get(comment.id) ?? 0;
  }

  /** Top-level counts only. Provider totals require no comment-page downloads. */
  async commentCount(
    userId: string | undefined,
    type: ConversationType,
    id: string,
    localCount: number,
  ): Promise<{ total: number; approximate: boolean; source: 'local' | 'commsuni' }> {
    const local = { total: localCount, approximate: false, source: 'local' as const };
    if (!userId || !this.client.enabled) return local;
    try {
      const target = await this.resolver.resolve(userId, type, id);
      if (!target.entityId || target.threadId !== id) return local;
      const data = object(
        await this.client.read(userId, this.resolver.path(target) + '/conversation', {}, 0),
      );
      const totals = object(data.comments);
      if (
        data.entityId !== target.entityId ||
        data.entityType !== target.entityType ||
        ![totals.archived, totals.native, totals.total].every(
          (value) => Number.isSafeInteger(value) && Number(value) >= 0,
        ) ||
        Number(totals.total) !== Number(totals.archived) + Number(totals.native)
      )
        throw new CommsUniError(502, 'invalid_conversation_counts');
      const [localTotals] = await this.prisma.$queryRaw<{ extra: bigint; approximate: boolean }[]>(
        localCommentCountQuery(type, id, target.entityId),
      );
      const extra = Number(localTotals.extra);
      const approximate = localTotals.approximate;
      return { total: Number(totals.total) + extra, approximate, source: 'commsuni' };
    } catch {
      // An unavailable/unmapped provider must not erase the usable local count.
      return local;
    }
  }

  async engagement(
    userId: string,
    type: ConversationType,
    id: string,
    includeLocalSelections = true,
  ): Promise<CommsUniEngagementDto> {
    const target = await this.resolver.resolve(userId, type, id);
    if (!target.entityId)
      return {
        available: false,
        writesEnabled: this.client.writesEnabled,
        sections: [],
        rating: null,
      };
    const [data, viewer] = await Promise.all([
      this.client.read(userId, this.resolver.path(target) + '/engagement', {}, 0),
      this.viewer(userId),
    ]);
    const result = decodeEngagement(data, target, viewer.writable);
    const castSection = result.sections.find((section) => section.kind === 'cast_vote');
    if (castSection?.options.length) {
      const cast = await this.prisma.mediaCast.findMany({
        where: { mediaId: target.mediaId },
        select: {
          id: true,
          characterExternalId: true,
          character: true,
          characterImageUrl: true,
          castMember: { select: { name: true, profileUrl: true } },
        },
      });
      castSection.options = mapCastOptions(castSection.options, cast);
    }
    if (!includeLocalSelections) return result;
    const where =
      type === 'EPISODE'
        ? { userId, episodeId: target.threadId }
        : { userId, mediaId: target.threadId };
    const [rating, reactions] = await Promise.all([
      this.prisma.rating.findFirst({ where, select: { rating: true } }),
      this.prisma.reaction.findMany({ where, select: { reaction: true } }),
    ]);
    for (const section of result.sections)
      for (const option of section.options) {
        option.localSelected =
          !!option.localValue &&
          (section.kind === 'star_rating'
            ? String(rating?.rating) === option.localValue
            : section.kind === 'emotion' &&
              reactions.some((row) => row.reaction === option.localValue));
      }
    return result;
  }
}
