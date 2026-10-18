// Account-level half of a native TV Watch Time restore.
//
// Library rows (history, watchlist, ratings, ...) travel through the normal staged import
// items. Two things cannot: contributions account deletion moved to the deleted account's
// ghost (reclaimed here before apply so they are not double counted), and account state that
// has no ImportItem type (profile, notification preferences, show tracking state, provider
// alerts, follows/blocks/list subscriptions). That state is staged on Import.restoreData and
// applied after the library sections.

import type { Prisma } from '@prisma/client';
import { deletedGhostIdentity, isDeletedUserAccount } from '../../../users/lib/deleted-user';
import type { TvwExport, TvwNotificationPreferences, TvwProfile, TvwSocial } from './format';

export const TVWATCHTIME_IMPORT_FORMAT = 'tvwatchtime';

export interface TvwRestoreData {
  version: 1;
  /** Signed account-restore token from the export; verified on confirm before any reclaim. */
  restoreToken: string | null;
  profile: TvwProfile | null;
  notificationPreferences: TvwNotificationPreferences | null;
  tracking: {
    mediaExportId: string;
    mediaId: string | null;
    dropped: boolean;
    pausedAt: string | null;
    rewatchStartedAt: string | null;
  }[];
  providerAlerts: {
    mediaExportId: string;
    mediaId: string | null;
    offerType: string;
    country: string;
    providerIds: number[];
    active: boolean;
  }[];
  social: TvwSocial;
}

export function buildRestoreData(
  parsed: TvwExport,
  mediaIdByExportId: Map<string, string>,
): TvwRestoreData {
  return {
    version: 1,
    restoreToken: parsed.restoreToken,
    profile: parsed.profile,
    notificationPreferences: parsed.notificationPreferences,
    tracking: parsed.shows
      .filter(
        (show) =>
          show.tracking &&
          (show.tracking.dropped || show.tracking.pausedAt || show.tracking.rewatchStartedAt),
      )
      .map((show) => ({
        mediaExportId: show.exportId,
        mediaId: mediaIdByExportId.get(show.exportId) ?? null,
        dropped: show.tracking!.dropped,
        pausedAt: show.tracking!.pausedAt?.toISOString() ?? null,
        rewatchStartedAt: show.tracking!.rewatchStartedAt?.toISOString() ?? null,
      })),
    providerAlerts: parsed.providerAlerts.map((alert) => ({
      ...alert,
      mediaId: mediaIdByExportId.get(alert.mediaExportId) ?? null,
    })),
    social: parsed.social,
  };
}

export interface ReclaimResult {
  ratings: number;
  reactions: number;
  characterVotes: number;
  deviceVotes: number;
  comments: number;
}

type ReclaimPrisma = {
  user: { findUnique: (args: any) => Promise<any> };
  $transaction: <T>(fn: (tx: any) => Promise<T>, options?: any) => Promise<T>;
};

/**
 * Move a deleted account's ghost-held contributions to the person's new account.
 *
 * Only runs when the original account no longer exists and its deterministic ghost does. Rows
 * whose target the new account already has an answer for are the same person's superseded
 * choice: the new account's value wins and the ghost copy is removed so community aggregates
 * count the person once. Comments keep their ids, so replies by other people stay attached.
 */
export async function reclaimDeletedAccount(
  prisma: ReclaimPrisma,
  userId: string,
  originalUserId: string | null | undefined,
): Promise<ReclaimResult | null> {
  if (!originalUserId || originalUserId === userId) return null;
  const original = await prisma.user.findUnique({
    where: { id: originalUserId },
    select: { id: true },
  });
  if (original) return null;
  const ghost = await prisma.user.findUnique({
    where: { email: deletedGhostIdentity(originalUserId).email },
    select: { id: true, email: true, username: true, isShadow: true },
  });
  if (!ghost || ghost.id === userId || !ghost.isShadow || !isDeletedUserAccount(ghost)) {
    return null;
  }
  const ghostId: string = ghost.id;

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtext(${`account-reclaim:${ghostId}`})) AS acquired
      `;
      if (!lock?.acquired) return null;

      const ratings = await tx.$executeRaw`
        UPDATE ratings AS g SET user_id = ${userId}
        WHERE g.user_id = ${ghostId}
          AND NOT EXISTS (
            SELECT 1 FROM ratings AS u
            WHERE u.user_id = ${userId}
              AND ((g.episode_id IS NOT NULL AND u.episode_id = g.episode_id)
                OR (g.media_id IS NOT NULL AND u.media_id = g.media_id))
          )`;
      await tx.$executeRaw`DELETE FROM ratings WHERE user_id = ${ghostId}`;

      const reactions = await tx.$executeRaw`
        UPDATE reactions AS g SET user_id = ${userId}
        WHERE g.user_id = ${ghostId}
          AND NOT EXISTS (
            SELECT 1 FROM reactions AS u
            WHERE u.user_id = ${userId}
              AND u.reaction = g.reaction
              AND ((g.episode_id IS NOT NULL AND u.episode_id = g.episode_id)
                OR (g.media_id IS NOT NULL AND u.media_id = g.media_id))
          )`;
      await tx.$executeRaw`DELETE FROM reactions WHERE user_id = ${ghostId}`;

      const characterVotes = await tx.$executeRaw`
        UPDATE character_votes AS g SET user_id = ${userId}
        WHERE g.user_id = ${ghostId}
          AND NOT EXISTS (
            SELECT 1 FROM character_votes AS u
            WHERE u.user_id = ${userId}
              AND ((g.episode_id IS NOT NULL AND u.episode_id = g.episode_id)
                OR (g.media_id IS NOT NULL AND u.media_id = g.media_id))
          )`;
      await tx.$executeRaw`DELETE FROM character_votes WHERE user_id = ${ghostId}`;

      // Device votes live on (watch-cleared) status rows. Fill an existing row's empty vote,
      // move the rest; the library apply later transitions those rows back to watched.
      await tx.$executeRaw`
        UPDATE user_episode_status AS u
        SET device = g.device, device_source = g.device_source
        FROM user_episode_status AS g
        WHERE g.user_id = ${ghostId} AND u.user_id = ${userId}
          AND u.episode_id = g.episode_id AND u.device IS NULL`;
      const episodeDevices = await tx.$executeRaw`
        UPDATE user_episode_status AS g SET user_id = ${userId}
        WHERE g.user_id = ${ghostId}
          AND NOT EXISTS (
            SELECT 1 FROM user_episode_status AS u
            WHERE u.user_id = ${userId} AND u.episode_id = g.episode_id
          )`;
      await tx.$executeRaw`DELETE FROM user_episode_status WHERE user_id = ${ghostId}`;
      await tx.$executeRaw`
        UPDATE user_movie_status AS u
        SET device = g.device, device_source = g.device_source
        FROM user_movie_status AS g
        WHERE g.user_id = ${ghostId} AND u.user_id = ${userId}
          AND u.media_id = g.media_id AND u.device IS NULL`;
      const movieDevices = await tx.$executeRaw`
        UPDATE user_movie_status AS g SET user_id = ${userId}
        WHERE g.user_id = ${ghostId}
          AND NOT EXISTS (
            SELECT 1 FROM user_movie_status AS u
            WHERE u.user_id = ${userId} AND u.media_id = g.media_id
          )`;
      await tx.$executeRaw`DELETE FROM user_movie_status WHERE user_id = ${ghostId}`;

      const comments = await tx.$executeRaw`
        UPDATE comments SET user_id = ${userId} WHERE user_id = ${ghostId}`;
      await tx.$executeRaw`
        UPDATE comment_images SET user_id = ${userId} WHERE user_id = ${ghostId}`;

      return {
        ratings: Number(ratings),
        reactions: Number(reactions),
        characterVotes: Number(characterVotes),
        deviceVotes: Number(episodeDevices) + Number(movieDevices),
        comments: Number(comments),
      };
    },
    { timeout: 5 * 60_000, maxWait: 10_000 },
  );
}

export interface AccountRestoreResult {
  tracking: number;
  providerAlerts: number;
  profileFields: number;
  notificationPreferences: boolean;
  following: number;
  blocked: number;
  listSubscriptions: number;
  likedLists: number;
}

const isEmptyJson = (value: unknown) =>
  value == null || (typeof value === 'object' && Object.keys(value as object).length === 0);

/**
 * Apply staged account state. Additive and idempotent: values the person has already changed on
 * the new account are never replaced; only schema defaults/empty fields are filled.
 * `mediaIdFor` resolves an exported media id to the reviewed import target.
 */
export async function applyAccountRestore(
  prisma: any,
  userId: string,
  importId: string,
  data: TvwRestoreData,
  mediaIdFor: (exportId: string, stagedMediaId: string | null) => string | null,
): Promise<AccountRestoreResult> {
  const result: AccountRestoreResult = {
    tracking: 0,
    providerAlerts: 0,
    profileFields: 0,
    notificationPreferences: false,
    following: 0,
    blocked: 0,
    listSubscriptions: 0,
    likedLists: 0,
  };

  // ---- Show tracking state (drop / pause / rewatch). ----
  const trackingTargets = new Map<string, TvwRestoreData['tracking'][number]>();
  for (const entry of data.tracking ?? []) {
    const mediaId = mediaIdFor(entry.mediaExportId, entry.mediaId);
    if (mediaId && !trackingTargets.has(mediaId)) trackingTargets.set(mediaId, entry);
  }
  if (trackingTargets.size) {
    const ids = [...trackingTargets.keys()];
    const [shows, statuses] = await Promise.all([
      prisma.mediaItem.findMany({ where: { id: { in: ids }, type: 'SHOW' }, select: { id: true } }),
      prisma.userShowStatus.findMany({
        where: { userId, mediaId: { in: ids } },
        select: { id: true, mediaId: true, dropped: true, pausedAt: true, rewatchStartedAt: true },
      }),
    ]);
    const showIds = new Set(shows.map((row: any) => row.id));
    const statusByMedia = new Map(statuses.map((row: any) => [row.mediaId, row]));
    const audit: any[] = [];
    for (const [mediaId, entry] of trackingTargets) {
      if (!showIds.has(mediaId)) continue;
      const existing: any = statusByMedia.get(mediaId);
      // The person already set a tracking state on this account; theirs wins.
      if (existing && (existing.dropped || existing.pausedAt || existing.rewatchStartedAt))
        continue;
      const next = {
        dropped: entry.dropped,
        // Dropped and paused are mutually exclusive in the library.
        pausedAt: entry.dropped || !entry.pausedAt ? null : new Date(entry.pausedAt),
        rewatchStartedAt: entry.rewatchStartedAt ? new Date(entry.rewatchStartedAt) : null,
      };
      if (existing) {
        await prisma.userShowStatus.update({ where: { id: existing.id }, data: next });
        audit.push({
          importId,
          targetTable: 'user_show_status',
          targetRecordId: existing.id,
          action: 'updated',
          previousData: { dropped: false, pausedAt: null },
          newData: {
            dropped: next.dropped,
            pausedAt: next.pausedAt?.toISOString() ?? null,
          },
        });
      } else {
        const created = await prisma.userShowStatus.create({
          data: { userId, mediaId, ...next },
          select: { id: true },
        });
        audit.push({
          importId,
          targetTable: 'user_show_status',
          targetRecordId: created.id,
          action: 'created',
        });
      }
      result.tracking++;
    }
    if (audit.length) await prisma.importAppliedRecord.createMany({ data: audit });
  }

  // ---- Streaming availability alerts. ----
  const alerts = (data.providerAlerts ?? []).flatMap((alert) => {
    const mediaId = mediaIdFor(alert.mediaExportId, alert.mediaId);
    return mediaId ? [{ ...alert, mediaId }] : [];
  });
  if (alerts.length) {
    const existingMedia = await prisma.mediaItem.findMany({
      where: { id: { in: [...new Set(alerts.map((alert) => alert.mediaId))] } },
      select: { id: true },
    });
    const valid = new Set(existingMedia.map((row: any) => row.id));
    const created = await prisma.watchProviderAlert.createMany({
      data: alerts
        .filter((alert) => valid.has(alert.mediaId))
        .map((alert) => ({
          userId,
          mediaId: alert.mediaId,
          offerType: alert.offerType,
          country: alert.country,
          providerIds: alert.providerIds,
          active: alert.active,
        })),
      skipDuplicates: true,
    });
    result.providerAlerts = created.count;
  }

  // ---- Profile: fill empty fields and schema defaults only. ----
  if (data.profile) {
    const profile = data.profile;
    const current = await prisma.userProfile.findUnique({ where: { userId } });
    const update: Record<string, unknown> = {};
    if (profile.displayName && !current?.displayName) update.displayName = profile.displayName;
    if (profile.bio && !current?.bio) update.bio = profile.bio;
    if (profile.location && !current?.location) update.location = profile.location;
    if (profile.isPrivate === true && !current?.isPrivate) update.isPrivate = true;
    if (profile.hideAnimeInExplore === true && !current?.hideAnimeInExplore) {
      update.hideAnimeInExplore = true;
    }
    if (
      !isEmptyJson(profile.exploreDefaultFilters) &&
      isEmptyJson(current?.exploreDefaultFilters)
    ) {
      update.exploreDefaultFilters = profile.exploreDefaultFilters;
    }
    if (!isEmptyJson(profile.exploreSections) && isEmptyJson(current?.exploreSections)) {
      update.exploreSections = profile.exploreSections;
    }
    if (
      profile.theme &&
      profile.theme !== 'DARK' &&
      (current?.themePreference ?? 'DARK') === 'DARK'
    ) {
      update.themePreference = profile.theme;
    }
    if (
      profile.language &&
      profile.language !== 'SYSTEM' &&
      (current?.languagePreference ?? 'SYSTEM') === 'SYSTEM'
    ) {
      update.languagePreference = profile.language;
    }
    result.profileFields = Object.keys(update).length;
    if (result.profileFields) {
      await prisma.userProfile.upsert({
        where: { userId },
        create: { userId, ...update },
        update,
      });
    }
  }

  // ---- Notification preferences: fill defaults only. ----
  if (data.notificationPreferences) {
    const prefs = data.notificationPreferences;
    const current = await prisma.notificationPreference.findUnique({ where: { userId } });
    const update: Record<string, unknown> = {};
    if (!isEmptyJson(prefs.categories) && isEmptyJson(current?.preferences)) {
      update.preferences = prefs.categories;
    }
    if (
      prefs.quietHoursEnabled &&
      prefs.quietHoursStart &&
      prefs.quietHoursEnd &&
      !current?.quietHoursEnabled
    ) {
      update.quietHoursEnabled = true;
      update.quietHoursStart = prefs.quietHoursStart;
      update.quietHoursEnd = prefs.quietHoursEnd;
    }
    if (prefs.timezone && !current?.timezone) update.timezone = prefs.timezone;
    if (
      prefs.timing &&
      prefs.timing !== 'AT_RELEASE' &&
      (current?.timing ?? 'AT_RELEASE') === 'AT_RELEASE'
    ) {
      update.timing = prefs.timing;
    }
    if (Object.keys(update).length) {
      await prisma.notificationPreference.upsert({
        where: { userId },
        create: { userId, ...update },
        update,
      });
      result.notificationPreferences = true;
    }
  }

  // ---- Social graph: blocks first (blocking implies not following), then follows. ----
  const social = data.social ?? {
    following: [],
    blocked: [],
    listSubscriptions: [],
    likedLists: [],
  };
  const usernames = [...new Set([...(social.following ?? []), ...(social.blocked ?? [])])];
  if (usernames.length) {
    const users = await prisma.user.findMany({
      where: {
        username: { in: usernames },
        isShadow: false,
        isSuspended: false,
        id: { not: userId },
      },
      select: { id: true, username: true },
    });
    const idByUsername = new Map<string, string>(users.map((row: any) => [row.username, row.id]));
    const blockedIds = (social.blocked ?? []).flatMap((name) => idByUsername.get(name) ?? []);
    if (blockedIds.length) {
      const created = await prisma.block.createMany({
        data: blockedIds.map((blockedId) => ({ blockerId: userId, blockedId })),
        skipDuplicates: true,
      });
      result.blocked = created.count;
    }
    const followIds = (social.following ?? []).flatMap((name) => idByUsername.get(name) ?? []);
    if (followIds.length) {
      const blocks = await prisma.block.findMany({
        where: {
          OR: [
            { blockerId: userId, blockedId: { in: followIds } },
            { blockerId: { in: followIds }, blockedId: userId },
          ],
        },
        select: { blockerId: true, blockedId: true },
      });
      const excluded = new Set(
        blocks.map((row: any) => (row.blockerId === userId ? row.blockedId : row.blockerId)),
      );
      const allowed = followIds.filter((targetId) => !excluded.has(targetId));
      if (allowed.length) {
        const created = await prisma.follow.createMany({
          data: allowed.map((targetId) => ({ followerId: userId, targetId })),
          skipDuplicates: true,
        });
        result.following = created.count;
      }
    }
  }

  const listIds = [
    ...new Set([
      ...(social.listSubscriptions ?? []).map((row) => row.listId),
      ...(social.likedLists ?? []),
    ]),
  ];
  if (listIds.length) {
    const lists = await prisma.customList.findMany({
      where: { id: { in: listIds }, visibility: 'PUBLIC', userId: { not: userId } },
      select: { id: true },
    });
    const visible = new Set(lists.map((row: any) => row.id));
    const subscriptions = (social.listSubscriptions ?? []).filter((row) => visible.has(row.listId));
    if (subscriptions.length) {
      const created = await prisma.listSubscription.createMany({
        data: subscriptions.map((row) => ({
          userId,
          listId: row.listId,
          notifyOnAdd: row.notifyOnAdd,
        })),
        skipDuplicates: true,
      });
      result.listSubscriptions = created.count;
    }
    const likes = (social.likedLists ?? []).filter((listId) => visible.has(listId));
    if (likes.length) {
      const created = await prisma.listLike.createMany({
        data: likes.map((listId) => ({ userId, listId })),
        skipDuplicates: true,
      });
      result.likedLists = created.count;
    }
  }

  return result;
}
