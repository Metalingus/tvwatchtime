import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

type Plan = Record<string, any>;
type Spec = { table: string; columns: string; condition: Prisma.Sql; policy: string };

/** Read-only row routing report. No bodies, credentials, image keys or archive payloads. */
export class IdentityTransferManifest {
  constructor(private readonly prisma: PrismaService) {}

  private specs(plan: Plan) {
    const sourceIds: string[] =
      plan.action === 'consolidate'
        ? (plan.details?.sourceMediaIds ??
          plan.members.filter((id: string) => id !== plan.targetMediaId))
        : [plan.mediaId];
    const ids = sourceIds.length ? sourceIds : [plan.mediaId];
    const scope = Prisma.join(ids);
    const episodes = Prisma.sql`SELECT e.id FROM episodes e JOIN seasons s ON s.id=e.season_id
      JOIN shows sh ON sh.id=s.show_id WHERE sh.media_id IN (${scope})`;
    const comments = Prisma.sql`(c.media_id IN (${scope}) OR
      (c.thread_type IN ('SHOW','MOVIE') AND c.thread_id IN (${scope})) OR
      (c.thread_type='EPISODE' AND c.thread_id IN (${episodes})))`;
    const media = Prisma.sql`x.media_id IN (${scope})`;
    const episode = Prisma.sql`x.episode_id IN (${episodes})`;
    const both = Prisma.sql`(${media} OR ${episode})`;
    const common = 'x.id,x.user_id AS "userId"';
    const specs: Record<string, Spec> = {
      episodes: {
        table: 'episodes x JOIN seasons s ON s.id=x.season_id JOIN shows sh ON sh.id=s.show_id',
        columns:
          'x.id,sh.media_id AS "mediaId",s.number AS "season",x.number AS "episode",x.structure_state AS "structureState"',
        condition: Prisma.sql`sh.media_id IN (${scope})`,
        policy: 'episode-map',
      },
      episodeStatuses: {
        table: 'user_episode_status x',
        columns: common + ',x.episode_id AS "episodeId",x.source',
        condition: episode,
        policy: 'episode-map',
      },
      history: {
        table: 'watch_history x',
        columns:
          common +
          ',x.media_id AS "mediaId",x.media_type AS "mediaType",x.episode_id AS "episodeId",x.source',
        condition: both,
        policy: 'typed-history',
      },
      ratings: {
        table: 'ratings x',
        columns: common + ',x.media_id AS "mediaId",x.episode_id AS "episodeId",x.source',
        condition: both,
        policy: 'manual-choice-wins',
      },
      reactions: {
        table: 'reactions x',
        columns: common + ',x.media_id AS "mediaId",x.episode_id AS "episodeId",x.source',
        condition: both,
        policy: 'manual-choice-wins',
      },
      characterVotes: {
        table: 'character_votes x',
        columns:
          common +
          ',x.media_id AS "mediaId",x.episode_id AS "episodeId",x.cast_id AS "castId",x.source',
        condition: both,
        policy: 'verified-role',
      },
      showStatuses: {
        table: 'user_show_status x',
        columns: common + ',x.media_id AS "mediaId"',
        condition: media,
        policy: 'show-progress',
      },
      movieStatuses: {
        table: 'user_movie_status x',
        columns: common + ',x.media_id AS "mediaId",x.source',
        condition: media,
        policy: 'movie-progress',
      },
      watchlist: {
        table: 'watchlist_items x',
        columns: common + ',x.media_id AS "mediaId",x.source',
        condition: media,
        policy: 'union',
      },
      favorites: {
        table: 'favorites x',
        columns: common + ',x.media_id AS "mediaId",x.source',
        condition: media,
        policy: 'union',
      },
      lists: {
        table: 'custom_list_items x',
        columns: 'x.id,x.list_id AS "listId",x.media_id AS "mediaId"',
        condition: media,
        policy: 'union',
      },
      alerts: {
        table: 'watch_provider_alerts x',
        columns: common + ',x.media_id AS "mediaId"',
        condition: media,
        policy: 'preserve-alert-preferences',
      },
      externalReviews: {
        table: 'external_reviews x',
        columns: 'x.id,x.media_id AS "mediaId",x.episode_id AS "episodeId"',
        condition: both,
        policy: 'retain-stable-review-id',
      },
      comments: {
        table: 'comments c',
        columns:
          'c.id,c.user_id AS "userId",c.thread_type AS "threadType",c.thread_id AS "threadId",c.media_id AS "mediaId",c.media_type AS "mediaType",c.parent_id AS "parentId"',
        condition: comments,
        policy: 'preserve-thread',
      },
    };
    for (const [key, table, owner] of [
      ['commentLikes', 'comment_likes', 'user_id'],
      ['spoilerReports', 'comment_spoiler_reports', 'user_id'],
      ['commentImages', 'comment_images', 'user_id'],
      ['moderationReports', 'reports', 'reporter_id'],
    ])
      specs[key] = {
        table: table + ' x JOIN comments c ON c.id=x.comment_id',
        columns:
          'x.id,x.' +
          owner +
          ' AS "userId",x.comment_id AS "commentId",c.thread_type AS "threadType",c.thread_id AS "threadId"',
        condition: comments,
        policy: key === 'moderationReports' ? 'retain-recovery-case' : 'follow-comment',
      };
    specs.reviewLikes = {
      table: 'external_review_likes x JOIN external_reviews r ON r.id=x.external_review_id',
      columns: common + ',x.external_review_id AS "externalReviewId"',
      condition: Prisma.sql`(r.media_id IN (${scope}) OR r.episode_id IN (${episodes}))`,
      policy: 'retain-stable-review-id',
    };
    return { specs, sourceIds: ids, episodes, comments, scope };
  }

  async summary(plan: Plan) {
    const { specs, sourceIds, scope, episodes, comments } = this.specs(plan);
    const relations = await Promise.all(
      Object.entries(specs).map(async ([key, spec]) => {
        const [row] = await this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT count(*)::int AS count FROM ${Prisma.raw(spec.table)} WHERE ${spec.condition}`);
        return {
          key,
          count: row.count,
          policy: plan.action === 'split' ? 'row-dependent: ' + spec.policy : spec.policy,
        };
      }),
    );
    const [unsafe] = await this.prisma.$queryRaw<
      Array<{ foreignHistory: number; ambiguousScope: number; pendingImages: number }>
    >(Prisma.sql`
      SELECT
        (SELECT count(*)::int FROM watch_history h JOIN media_items m ON m.id=h.media_id
          WHERE h.media_id IN (${scope}) AND (
            (${plan.action === 'consolidate'} AND h.media_type<>m.type) OR
            (h.episode_id IS NOT NULL AND NOT EXISTS(
              SELECT 1 FROM episodes e JOIN seasons s ON s.id=e.season_id JOIN shows sh ON sh.id=s.show_id
              WHERE e.id=h.episode_id AND sh.media_id=h.media_id)))) AS "foreignHistory",
        ((SELECT count(*) FROM ratings x WHERE x.media_id IN (${scope}) AND x.episode_id IS NOT NULL)+
         (SELECT count(*) FROM reactions x WHERE x.media_id IN (${scope}) AND x.episode_id IS NOT NULL)+
         (SELECT count(*) FROM character_votes x WHERE x.media_id IN (${scope}) AND x.episode_id IS NOT NULL))::int AS "ambiguousScope",
        (SELECT count(*)::int FROM comment_images x JOIN comments c ON c.id=x.comment_id
          WHERE ${comments} AND x.status IN ('pending','uploaded','validating','moderating','processing','needs_manual_review')) AS "pendingImages"
    `);
    return {
      sourceMediaIds: sourceIds,
      targetMediaId: plan.targetMediaId,
      relations,
      unsafe,
      blocked:
        ['consolidate', 'split'].includes(plan.action) && Object.values(unsafe).some((n) => n > 0),
      episodeMappingCount: (plan.details?.episodeMappings ?? []).length,
      policy:
        plan.action === 'split'
          ? 'Only proven episode/typed relations transfer. Untyped media choices remain on the original.'
          : plan.action === 'consolidate'
            ? 'Preserve sources and copy to the canonical target. Existing manual choices win.'
            : 'No user relations are moved.',
    };
  }
}
