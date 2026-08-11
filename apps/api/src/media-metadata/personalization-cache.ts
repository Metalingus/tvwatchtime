import type { RedisService } from '../common/redis/redis.service';

export const personalizationVersionKey = (userId: string) => `foryou:v4:${userId}:version`;

/**
 * Advance one user's taste generation without deleting their last good recommendation snapshot.
 * The background warmer publishes replacements only for the generation it actually computed.
 */
export async function markPersonalizationDirty(redis: RedisService, userId: string): Promise<void> {
  if (!userId) return;
  await redis.client.incr(personalizationVersionKey(userId));
}
