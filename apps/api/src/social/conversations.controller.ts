import { applyLocalVote } from '../common/local-vote-mutation';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
  UseFilters,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Matches,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ArrayUnique,
} from 'class-validator';
import type { Prisma } from '@prisma/client';
import type {
  CommentSort,
  ConversationType,
  CommsUniEngagementKind,
  ConversationCountDto,
} from '@tvwatch/shared';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommsUniClient, UUID } from '../commsuni/commsuni.client';
import { CommsUniResolver } from '../commsuni/commsuni.resolver';
import { CommsUniReadService, object, httpsUrl } from '../commsuni/commsuni.read.service';
import { CommsUniPublicationService } from '../commsuni/commsuni.publication.service';
import { ConversationsService } from './conversations.service';
import { CommentsService } from './comments.service';
import { TranslationService } from './translation.service';
import { TranslateContentDto } from './dto/comment.dto';
import { Throttle } from '@nestjs/throttler';
import { CommsUniExceptionFilter } from '../commsuni/commsuni.exception-filter';

class ConversationQuery {
  @IsIn(['SHOW', 'MOVIE', 'EPISODE']) threadType!: ConversationType;
  @IsString() @MaxLength(128) threadId!: string;
  @IsOptional() @IsIn(['LATEST', 'MOST_LIKED']) sort: CommentSort = 'LATEST';
  @IsOptional() @IsUUID() cursor?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^(?:[a-z0-9][a-z0-9_-]*|__local__)$/)
  source?: string;
}
class MediaGrantRequest {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(16)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  commentIds!: string[];
}
class RemoteAction {
  @IsIn(['like', 'unlike', 'spoiler', 'unspoiler', 'authorSpoiler', 'delete', 'report', 'block'])
  action!: string;
  @IsOptional() @IsUUID() actionId?: string;
  @IsOptional()
  @IsIn(['spam', 'abuse', 'spoiler', 'sexual', 'illegal', 'other', 'mine_hide', 'mine_claim'])
  reason?: string;
  @IsOptional() @IsBoolean() isSpoiler?: boolean;
}
class EngagementAction {
  @IsIn([
    'emotion',
    'star_rating',
    'cast_vote',
    'watch_device',
    'watch_platform',
    'movie_interest',
    'rating',
  ])
  kind!: CommsUniEngagementKind | 'rating';
  @IsOptional() @IsString() @MaxLength(256) optionKey?: string;
  @IsBoolean() selected!: boolean;
  @IsUUID() actionId!: string;
}

@Controller('conversations')
@UseFilters(CommsUniExceptionFilter)
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(
    private readonly feed: ConversationsService,
    private readonly reads: CommsUniReadService,
    private readonly resolver: CommsUniResolver,
    private readonly client: CommsUniClient,
    private readonly publication: CommsUniPublicationService,
    private readonly prisma: PrismaService,
    private readonly comments: CommentsService,
    private readonly translations: TranslationService,
  ) {}

  @Get()
  page(@CurrentUser('id') userId: string, @Query() query: ConversationQuery) {
    return this.feed.page(
      userId,
      query.threadType,
      query.threadId,
      query.sort,
      query.cursor,
      undefined,
      query.source,
    );
  }

  @Get('counts')
  async counts(
    @CurrentUser('id') userId: string,
    @Query() query: ConversationQuery,
  ): Promise<ConversationCountDto> {
    const threadId = await this.resolver.canonicalThread(query.threadType, query.threadId);
    const localCount = await this.prisma.comment.count({
      where: {
        threadType: query.threadType,
        threadId,
        parentId: null,
        commsUniParentId: null,
        externalReviewId: null,
        hidden: false,
        adminDeleted: false,
        deletedByUser: false,
      },
    });
    return {
      threadType: query.threadType,
      threadId,
      ...(await this.reads.commentCount(userId, query.threadType, threadId, localCount)),
    };
  }

  @Get('sources')
  async sources(@CurrentUser('id') userId: string) {
    if (!this.client.enabled) return { sources: [], ownSource: null };
    return {
      sources: [...(await this.reads.sources(userId)).values()],
      ownSource: this.client.sourceSlug || null,
    };
  }

  @Get('comments/:id')
  async comment(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ConversationQuery,
  ) {
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const comment = await this.reads.comment(userId, target, id);
    const thread =
      (
        await this.comments.threadContexts([
          { id: 'thread', threadType: target.threadType, threadId: target.threadId },
        ])
      ).get('thread') ?? null;
    const revisions = await this.comments.localRevisionsForShared(
      userId,
      target.threadType,
      target.threadId,
      [id],
    );
    return {
      comment,
      thread,
      threadType: target.threadType,
      threadId: target.threadId,
      localRevision: revisions[0]?.comment,
    };
  }

  @Get('comments/:id/replies')
  replies(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ConversationQuery,
  ) {
    if (!UUID.test(id)) throw new BadRequestException('Invalid comment ID');
    return this.feed.page(
      userId,
      query.threadType,
      query.threadId,
      query.sort,
      query.cursor,
      id,
      query.source,
    );
  }

  @Get('comments/:id/media')
  async media(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ConversationQuery,
  ) {
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const comment = await this.reads.comment(userId, target, id);
    if (comment.media?.kind !== 'archive') return { url: null };
    return { url: await this.client.mediaUrl(userId, id) };
  }

  @Post('media-grants')
  async mediaGrants(
    @CurrentUser('id') userId: string,
    @Query() query: ConversationQuery,
    @Body() dto: MediaGrantRequest,
  ) {
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const comments = await this.reads.commentsByIds(userId, target, dto.commentIds);
    const visible = new Set(
      comments.filter((row) => !row.deleted && row.media?.kind === 'archive').map((row) => row.id),
    );
    const ids = dto.commentIds.filter((id) => visible.has(id));
    const response = ids.length ? await this.client.mediaGrants(userId, ids) : { grants: [] };
    const grants = object(response);
    const returned = new Map(
      (Array.isArray(grants.grants) ? grants.grants : []).map((row) => {
        const grant = object(row);
        return [grant.commentId, grant];
      }),
    );
    return {
      grants: dto.commentIds.map((commentId) => {
        const grant = returned.get(commentId);
        const url = httpsUrl(grant?.url);
        return visible.has(commentId) && grant?.status === 'granted' && url
          ? { commentId, status: 'granted', url }
          : { commentId, status: 'missing', url: null };
      }),
    };
  }

  @Post('comments/:id/translate')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async translate(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ConversationQuery,
    @Body() dto: TranslateContentDto,
  ) {
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const comment = await this.reads.comment(userId, target, id);
    return this.translations.translateTransient(
      this.client.scope + ':' + userId + ':' + id,
      comment.text ?? '',
      dto.targetLanguage,
      comment.mentions,
    );
  }

  @Get('engagement')
  async engagement(@CurrentUser('id') userId: string, @Query() query: ConversationQuery) {
    if (!this.client.enabled)
      return { available: false, writesEnabled: false, sections: [], rating: null };
    try {
      return await this.reads.engagement(userId, query.threadType, query.threadId);
    } catch {
      return { available: false, writesEnabled: false, sections: [], rating: null };
    }
  }

  @Post('comments/:id/actions')
  async action(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() query: ConversationQuery,
    @Body() dto: RemoteAction,
  ) {
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const comment = await this.reads.comment(userId, target, id);
    if (comment.deleted) throw new BadRequestException('Comment has been deleted');
    if (dto.action === 'block') {
      await this.prisma.commsUniAuthorBlock.upsert({
        where: {
          userId_scope_authorId: { userId, scope: this.client.scope, authorId: comment.author.id },
        },
        update: {},
        create: {
          userId,
          scope: this.client.scope,
          authorId: comment.author.id,
          name: comment.author.displayName.slice(0, 200),
        },
      });
      return { state: 'LOCAL' };
    }
    if (dto.action === 'report') {
      const reason = dto.reason ?? 'other';
      if (reason.startsWith('mine_') && comment.origin.kind !== 'tvtime')
        throw new BadRequestException('Ownership reports apply only to archived TV Time comments');
      await this.prisma.commsUniReport.upsert({
        where: { userId_scope_commentId: { userId, scope: this.client.scope, commentId: id } },
        update: {},
        create: {
          userId,
          scope: this.client.scope,
          commentId: id,
          entityId: comment.entityId,
          reason,
        },
      });
      if (!this.client.writesEnabled) return { state: 'LOCAL' };
      if (!dto.actionId) throw new BadRequestException('Action ID is required');
      const op = await this.publication.enqueue(
        userId,
        'POST',
        '/comments/' + id + '/reports',
        { reason },
        dto.actionId,
      );
      return { state: op.state, operationId: op.id };
    }
    this.client.assertWrites();
    if (!dto.actionId) throw new BadRequestException('Action ID is required');
    let method = 'PUT';
    let path = '/comments/' + id;
    let body: unknown = null;
    if (dto.action === 'delete') {
      if (!comment.actions.delete) throw new BadRequestException('You cannot delete this comment');
      method = 'DELETE';
    } else if (dto.action === 'authorSpoiler') {
      if (!comment.actions.authorSpoiler || typeof dto.isSpoiler !== 'boolean')
        throw new BadRequestException('Invalid spoiler update');
      method = 'PATCH';
      body = { isSpoiler: dto.isSpoiler };
    } else {
      if (!comment.actions.like) throw new BadRequestException('Shared actions are unavailable');
      const spoiler = dto.action === 'spoiler' || dto.action === 'unspoiler';
      path += spoiler ? '/spoiler' : '/like';
      method = dto.action === 'unlike' || dto.action === 'unspoiler' ? 'DELETE' : 'PUT';
    }
    const op = await this.publication.enqueue(
      userId,
      method,
      path,
      body,
      dto.actionId,
      {
        threadType: target.threadType,
        threadId: target.threadId,
        fingerprint: target.fingerprint,
        reference: target.reference,
        entityId: target.entityId,
      },
      method === 'DELETE',
    );
    if (dto.action === 'delete')
      await this.prisma.comment.updateMany({
        where: { userId, commsUniCommentId: id },
        data: { deletedByUser: true },
      });
    return { state: op.state, operationId: op.id };
  }

  @Post('engagement')
  async vote(
    @CurrentUser('id') userId: string,
    @Query() query: ConversationQuery,
    @Body() dto: EngagementAction,
  ) {
    this.client.assertWrites();
    const target = await this.resolver.resolve(userId, query.threadType, query.threadId);
    const engagement = await this.reads.engagement(userId, query.threadType, query.threadId);
    if (!engagement.writesEnabled || dto.kind === 'rating')
      throw new BadRequestException(
        'Use TVWatch five-star ratings; 0–10 conversion is unsupported',
      );
    const section = engagement.sections.find((row) => row.kind === dto.kind);
    const option = section?.options.find((row) => row.key === dto.optionKey);
    if (!option) throw new BadRequestException('Unknown engagement option');
    const nativeKind = ['star_rating', 'emotion', 'cast_vote', 'watch_device'].includes(dto.kind);
    if (nativeKind && !option.localValue)
      throw new BadRequestException('Unmapped engagement option');
    const value = option.localValue!;
    const localMutation = nativeKind
      ? async (tx: Prisma.TransactionClient) => {
          const episodeId = target.threadType === 'EPISODE' ? target.threadId : null;
          const mediaId = episodeId ? null : target.mediaId;
          if (episodeId) {
            const status = await tx.userEpisodeStatus.findUnique({
              where: { userId_episodeId: { userId, episodeId } },
            });
            if (!status?.watched)
              throw new BadRequestException('Mark the episode as watched first');
          } else if (target.threadType === 'MOVIE') {
            const status = await tx.userMovieStatus.findUnique({
              where: { userId_mediaId: { userId, mediaId: mediaId! } },
            });
            if (!status?.watched) throw new BadRequestException('Mark the movie as watched first');
          } else if (dto.kind !== 'star_rating')
            throw new BadRequestException('Unsupported show vote');
          if (dto.kind === 'cast_vote') {
            const credit = await tx.mediaCast.findFirst({
              where: { id: value, mediaId: target.mediaId },
              select: { id: true },
            });
            if (!credit) throw new BadRequestException('Character is not part of this title');
          }
          await applyLocalVote(
            tx,
            userId,
            episodeId ? { episodeId } : { mediaId: mediaId! },
            dto.kind,
            value,
            dto.selected,
          );
        }
      : undefined;
    const op = await this.publication.enqueue(
      userId,
      'SELECTION',
      this.resolver.path(target) + '/engagement/' + dto.kind,
      {
        intent: {
          kind: dto.kind,
          ...(nativeKind ? { value } : { optionKey: dto.optionKey }),
          selected: dto.selected,
        },
      },
      dto.actionId,
      {
        threadType: target.threadType,
        threadId: target.threadId,
        fingerprint: target.fingerprint,
        reference: target.reference,
        entityId: target.entityId,
      },
      false,
      localMutation,
    );
    return { state: op.state, operationId: op.id };
  }

  @Post('comments/:id/finalize')
  async finalize(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.publication.finalize(userId, id);
    return { ok: true };
  }

  @Get('blocks')
  blocks(@CurrentUser('id') userId: string) {
    return this.prisma.commsUniAuthorBlock.findMany({
      where: { userId, scope: this.client.scope },
      select: { authorId: true, name: true },
    });
  }

  @Delete('blocks/:id')
  async unblock(@CurrentUser('id') userId: string, @Param('id') id: string) {
    await this.prisma.commsUniAuthorBlock.deleteMany({
      where: { userId, scope: this.client.scope, authorId: id },
    });
    return { ok: true };
  }

  @Get('operations/:id')
  async operation(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const row = await this.prisma.commsUniOutbox.findFirst({
      where: { id, identity: { userId, scope: this.client.scope } },
      select: {
        id: true,
        state: true,
        errorCode: true,
        commentId: true,
        remoteId: true,
        target: true,
        nextAttemptAt: true,
      },
    });
    if (!row) throw new BadRequestException('Unknown operation');
    const { target, ...status } = row;
    return { ...status, reason: object(object(target).lastError).reason ?? null };
  }
}
