// Deleted-account identities preserve public/community contributions without retaining
// credentials, profile data, private library state, or viewing history. Legacy deletions
// used one shared account; new deletions use one unique ghost per account so per-user
// rating/reaction/vote uniqueness remains meaningful.

import { createHash } from 'crypto';
import { prepareCommsUniDeletion } from '../../commsuni/commsuni.cleanup';
import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../common/prisma/prisma.service';

export const DELETED_USER_EMAIL = 'deleted-user@system.local';
export const DELETED_USER_USERNAME = 'deleted-user';
export const DELETED_GHOST_EMAIL_PREFIX = 'deleted+';
export const DELETED_GHOST_EMAIL_SUFFIX = '@shadow.local';

/** Usernames that may never be registered or claimed (system identities). */
export const RESERVED_USERNAMES = new Set([DELETED_USER_USERNAME]);

/** Emails that may never be registered or authenticated (legacy system identity). */
export const RESERVED_USER_EMAILS = new Set([DELETED_USER_EMAIL]);

export function isReservedUserEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (
    RESERVED_USER_EMAILS.has(normalized) ||
    (normalized.startsWith(DELETED_GHOST_EMAIL_PREFIX) &&
      normalized.endsWith(DELETED_GHOST_EMAIL_SUFFIX))
  );
}

/** True for the legacy shared account and the new per-deletion ghost identities. */
export function isDeletedUserAccount(u: {
  email?: string | null;
  username?: string | null;
}): boolean {
  const email = u?.email?.toLowerCase() ?? '';
  return (
    email === DELETED_USER_EMAIL ||
    (email.startsWith(DELETED_GHOST_EMAIL_PREFIX) && email.endsWith(DELETED_GHOST_EMAIL_SUFFIX)) ||
    u?.username === DELETED_USER_USERNAME
  );
}

type PrismaLike = Pick<PrismaService, 'user'>;

// Large imported accounts can contain hundreds of thousands of dependent rows. Keep the
// privacy-preserving transfer + cascade atomic, but allow enough time for PostgreSQL to finish
// it. Duplicate requests never wait out this budget because the advisory lock below is try-only.
const DELETE_TRANSACTION_TIMEOUT_MS = 15 * 60_000;
// Prisma's interactive-transaction timeout does not cancel a PostgreSQL statement that is
// already running. Keep database-side limits inside the transaction so a blocked cascade
// releases the per-account advisory lock before the Prisma transaction budget expires.
const DELETE_STATEMENT_TIMEOUT_MS = 14 * 60_000;
const DELETE_LOCK_TIMEOUT_MS = 30_000;
const COUNTER_UPDATE_CHUNK_SIZE = 5_000;
const COMMENT_TRANSFER_CHUNK_SIZE = 5_000;

/**
 * Legacy shared deleted-user account. Retained for existing rows and comment-import reclaim
 * compatibility; new account deletions use a unique ghost instead.
 */
export async function getOrCreateDeletedUser(prisma: PrismaLike): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { email: DELETED_USER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;
  try {
    const created = await prisma.user.create({
      data: {
        email: DELETED_USER_EMAIL,
        username: DELETED_USER_USERNAME,
        passwordHash: null,
        role: 'USER',
        isShadow: false,
        isSuspended: true,
        profile: { create: { displayName: 'Deleted user' } },
      },
      select: { id: true },
    });
    return created.id;
  } catch (e: any) {
    if (e?.code === 'P2002') {
      const found = await prisma.user.findUnique({
        where: { email: DELETED_USER_EMAIL },
        select: { id: true },
      });
      if (found) return found.id;
    }
    throw e;
  }
}

function deletedGhostIdentity(userId: string): { email: string; username: string } {
  const fingerprint = createHash('sha256')
    .update(`tvwatch:deleted:${userId}`)
    .digest('hex')
    .slice(0, 20);
  return {
    email: `${DELETED_GHOST_EMAIL_PREFIX}${fingerprint}${DELETED_GHOST_EMAIL_SUFFIX}`,
    username: `deleted-${fingerprint}`,
  };
}

export type DeletedUserResult = {
  ghostUserId: string;
  commentsPreserved: number;
  commentsDeleted: number;
  ratingsPreserved: number;
  reactionsPreserved: number;
  characterVotesPreserved: number;
  deviceVotesPreserved: number;
};

export class AccountDeletionInProgressError extends Error {
  constructor() {
    super('Account deletion is already in progress');
    this.name = 'AccountDeletionInProgressError';
  }
}

/**
 * Privacy-preserving deletion:
 * - creates one non-login ghost identity for this account;
 * - moves only comments required by another person's replies to it;
 * - deletes the account's remaining comments and moves aggregate contributions to the ghost;
 * - removes watched state from the retained device-vote rows;
 * - deletes the original user so every other user-owned relation follows its normal cascade.
 *
 * A unique ghost is required: moving every deleted person's ratings/votes to one shared user
 * would collide on the per-user unique constraints and corrupt community aggregates.
 */
export async function anonymizeAndDeleteUser(
  prisma: PrismaService,
  userId: string,
): Promise<DeletedUserResult | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, username: true },
  });
  if (!user || isDeletedUserAccount(user)) return null;

  const identity = deletedGhostIdentity(userId);

  // Counter inputs are read before the old user's likes/reports cascade away.
  const [liked, flagged, externalReviewLikes] = await Promise.all([
    prisma.commentLike.findMany({ where: { userId }, select: { commentId: true } }),
    prisma.commentSpoilerReport.findMany({ where: { userId }, select: { commentId: true } }),
    prisma.externalReviewLike.findMany({
      where: { userId },
      select: { externalReviewId: true },
    }),
  ]);
  const likedCommentIds = [...new Set(liked.map((row) => row.commentId))];
  const flaggedCommentIds = [...new Set(flagged.map((row) => row.commentId))];
  const likedReviewIds = [...new Set(externalReviewLikes.map((row) => row.externalReviewId))];

  const decrementCounter = async (
    tx: any,
    model: 'comment' | 'externalReview',
    ids: string[],
    field: 'likesCount' | 'spoilerCount',
  ) => {
    for (let i = 0; i < ids.length; i += COUNTER_UPDATE_CHUNK_SIZE) {
      await tx[model].updateMany({
        where: { id: { in: ids.slice(i, i + COUNTER_UPDATE_CHUNK_SIZE) } },
        data: { [field]: { decrement: 1 } },
      });
    }
    await tx[model].updateMany({
      where: { [field]: { lt: 0 } },
      data: { [field]: 0 },
    });
  };

  return prisma.$transaction(
    async (tx: any) => {
      // Serialize duplicate email-link/admin/self-delete requests for the same account without
      // letting a retry spend its whole transaction timeout waiting behind the first request.
      // The try-lock returns a Prisma-supported boolean (unlike pg_advisory_xact_lock's `void`).
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`account-delete:${userId}`})) AS acquired
      `;
      if (!lock?.acquired) throw new AccountDeletionInProgressError();
      await tx.$queryRaw`
        SELECT
          set_config('lock_timeout', ${String(DELETE_LOCK_TIMEOUT_MS)}, true),
          set_config('statement_timeout', ${String(DELETE_STATEMENT_TIMEOUT_MS)}, true)
      `;
      const current = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, username: true },
      });
      if (!current || isDeletedUserAccount(current)) return null;

      const ghost = await tx.user.create({
        data: {
          email: identity.email,
          username: identity.username,
          passwordHash: null,
          role: 'USER',
          isShadow: true,
          isSuspended: true,
          emailVerified: false,
          mustChangePassword: false,
          onboardingStatus: 'SKIPPED',
          profile: {
            create: {
              displayName: 'Deleted user',
              bio: null,
              avatarUrl: null,
              coverUrl: null,
              isPrivate: true,
            },
          },
        },
        select: { id: true },
      });

      // Keep an owned comment only when a comment by another account exists somewhere below
      // it. This preserves every ancestor needed to keep another person's reply reachable,
      // while removing an all-self-authored branch instead of leaving unnecessary ghosts.
      // We inspect the real tree rather than repliesCount because that field is denormalized.
      const protectedCommentRows = await tx.$queryRaw<Array<{ id: string }>>`
        WITH RECURSIVE owned_descendants (owner_id, id, user_id) AS (
          SELECT owner.id, child.id, child.user_id
          FROM comments AS owner
          INNER JOIN comments AS child ON child.parent_id = owner.id
          WHERE owner.user_id = ${userId}

          UNION

          SELECT tree.owner_id, child.id, child.user_id
          FROM owned_descendants AS tree
          INNER JOIN comments AS child ON child.parent_id = tree.id
        )
        SELECT DISTINCT owner_id AS id
        FROM owned_descendants
        WHERE user_id <> ${userId}
      `;
      const protectedCommentIds = [
        ...new Set(protectedCommentRows.map((row: { id: string }) => row.id)),
      ];
      const protectedCommentIdSet = new Set(protectedCommentIds);
      const ownedComments = await tx.comment.findMany({
        where: { userId },
        select: { id: true, parentId: true },
      });
      const deletedCommentIds = new Set(
        ownedComments
          .filter((comment: { id: string }) => !protectedCommentIdSet.has(comment.id))
          .map((comment: { id: string }) => comment.id),
      );
      const affectedParentIds = [
        ...new Set(
          ownedComments
            .filter(
              (comment: { id: string; parentId: string | null }) =>
                deletedCommentIds.has(comment.id) &&
                comment.parentId !== null &&
                !deletedCommentIds.has(comment.parentId),
            )
            .map((comment: { parentId: string }) => comment.parentId),
        ),
      ];

      let commentsPreserved = 0;
      for (let i = 0; i < protectedCommentIds.length; i += COMMENT_TRANSFER_CHUNK_SIZE) {
        const ids = protectedCommentIds.slice(i, i + COMMENT_TRANSFER_CHUNK_SIZE);
        const moved = await tx.comment.updateMany({
          where: { userId, id: { in: ids } },
          data: { userId: ghost.id },
        });
        commentsPreserved += moved.count;
        // CommentImage.userId is intentionally a scalar rather than a User FK. Keep its
        // ownership aligned with a preserved comment so the deleted user id is not retained.
        await tx.commentImage.updateMany({
          where: { OR: [{ commentId: { in: ids } }, { retainedCommentId: { in: ids } }] },
          data: { userId: ghost.id },
        });
      }
      const commentsDeleted = await tx.comment.deleteMany({ where: { userId } });

      if (affectedParentIds.length) {
        // Recompute from real children after deletion rather than decrementing a potentially
        // stale counter. Prisma.join keeps every id parameterized.
        await tx.$executeRaw(
          Prisma.sql`
            UPDATE comments AS parent
            SET replies_count = (
              SELECT COUNT(*)::integer
              FROM comments AS child
              WHERE child.parent_id = parent.id
            )
            WHERE parent.id IN (${Prisma.join(affectedParentIds)})
          `,
        );
      }

      const [ratings, reactions, characterVotes] = await Promise.all([
        tx.rating.updateMany({ where: { userId }, data: { userId: ghost.id } }),
        tx.reaction.updateMany({ where: { userId }, data: { userId: ghost.id } }),
        tx.characterVote.updateMany({ where: { userId }, data: { userId: ghost.id } }),
      ]);

      // Device is a community vote stored on the status row. Preserve it while explicitly
      // removing every watch/progress signal from that row; rows without a vote are private
      // status only and are left for the original-user cascade.
      const [episodeDevices, movieDevices] = await Promise.all([
        tx.userEpisodeStatus.updateMany({
          where: { userId, device: { not: null } },
          data: {
            userId: ghost.id,
            watched: false,
            watchedAt: null,
            watchCount: 0,
          },
        }),
        tx.userMovieStatus.updateMany({
          where: { userId, device: { not: null } },
          data: {
            userId: ghost.id,
            watched: false,
            watchedAt: null,
            watchCount: 0,
          },
        }),
      ]);

      // These token/audit staging tables deliberately have no User FK, so scrub them
      // explicitly before deleting the original account.
      await Promise.all([
        tx.passwordReset.deleteMany({
          where: { OR: [{ userId }, { email: current.email }] },
        }),
        tx.deletionRequest.updateMany({
          where: { OR: [{ userId }, { email: current.email }] },
          data: { userId: null, email: identity.email },
        }),
        tx.pushNotificationJob.deleteMany({ where: { userId } }),
      ]);

      // Everything not moved above is private account/library state and cascades here:
      // credentials, profile, devices, lists, history, watchlist, favorites, statuses,
      // follows, notifications, imports, badges, statistics, reports, and contacts.
      if (tx.commsUniIdentity) await prepareCommsUniDeletion(tx, userId);
      await tx.user.delete({ where: { id: userId } });

      if (likedCommentIds.length) {
        await decrementCounter(tx, 'comment', likedCommentIds, 'likesCount');
      }
      if (flaggedCommentIds.length) {
        await decrementCounter(tx, 'comment', flaggedCommentIds, 'spoilerCount');
      }
      if (likedReviewIds.length) {
        await decrementCounter(tx, 'externalReview', likedReviewIds, 'likesCount');
      }

      return {
        ghostUserId: ghost.id,
        commentsPreserved,
        commentsDeleted: commentsDeleted.count,
        ratingsPreserved: ratings.count,
        reactionsPreserved: reactions.count,
        characterVotesPreserved: characterVotes.count,
        deviceVotesPreserved: episodeDevices.count + movieDevices.count,
      };
    },
    { timeout: DELETE_TRANSACTION_TIMEOUT_MS, maxWait: 10_000 },
  );
}
