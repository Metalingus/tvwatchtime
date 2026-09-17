import { Prisma } from '@prisma/client';
import type { ConversationType } from '@tvwatch/shared';
import { UUID } from './commsuni.client';

/** Return one aggregate row instead of materializing a title's comment history in Node. */
export function localCommentCountQuery(type: ConversationType, id: string, entityId: string) {
  return Prisma.sql`
    WITH candidates AS (
      SELECT
        c.has_local_revision AND
          (NULLIF(c.commsuni_comment_id, '') IS NULL OR c.source IS DISTINCT FROM 'MANUAL') AS independent,
        COALESCE(
          (c.commsuni_entity_id = ${entityId} AND c.commsuni_comment_id ~* ${UUID.source})
          OR (origin.commsuni_entity_id = ${entityId} AND origin.commsuni_comment_id ~* ${UUID.source}),
          false
        ) AS shared,
        (COALESCE(c.source::text, 'MANUAL') <> 'MANUAL'
          OR NULLIF(c.source_key, '') IS NOT NULL
          OR COALESCE(c.commsuni_state IN ('SENDING', 'RETRY', 'SYNCED'), false)) AS uncertain
      FROM comments c
      LEFT JOIN comments origin ON origin.id = c.commsuni_origin_id
      WHERE c.thread_type = ${type}::"CommentThreadType" AND c.thread_id = ${id}
        AND c.parent_id IS NULL AND c.commsuni_parent_id IS NULL AND c.external_review_id IS NULL
        AND NOT c.hidden AND NOT c.admin_deleted AND NOT c.deleted_by_user
    )
    SELECT count(*) AS extra, COALESCE(bool_or(NOT independent AND uncertain), false) AS approximate
    FROM candidates WHERE NOT shared OR independent
  `;
}
