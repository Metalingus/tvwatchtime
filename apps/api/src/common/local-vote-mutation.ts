import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Shared persistence for native controls and explicit provider-option actions.
 * Callers validate watched state and cast membership, then commit this with the outbox intent.
 */
export async function applyLocalVote(
  tx: Prisma.TransactionClient,
  userId: string,
  target: { episodeId: string; mediaId?: never } | { mediaId: string; episodeId?: never },
  kind: string,
  value: string | null,
  selected: boolean,
) {
  const where = { userId, ...target };
  const unique = target.episodeId
    ? { userId_episodeId: { userId, episodeId: target.episodeId } }
    : { userId_mediaId: { userId, mediaId: target.mediaId! } };
  if (kind === 'star_rating') {
    if (selected && (!value || !/^[1-5]$/.test(value)))
      throw new BadRequestException('Invalid rating');
    if (selected)
      await tx.rating.upsert({
        where: unique,
        create: { ...where, rating: Number(value), source: 'MANUAL' },
        update: { rating: Number(value), source: 'MANUAL', sourceKey: null },
      });
    else
      await tx.rating.deleteMany({
        where: { ...where, ...(value == null ? {} : { rating: Number(value) }) },
      });
  } else if (kind === 'emotion') {
    const reaction = value as any;
    const key = target.episodeId
      ? { userId_episodeId_reaction: { userId, episodeId: target.episodeId, reaction } }
      : { userId_mediaId_reaction: { userId, mediaId: target.mediaId!, reaction } };
    if (selected)
      await tx.reaction.upsert({
        where: key,
        create: { ...where, reaction, source: 'MANUAL' },
        update: { source: 'MANUAL', sourceKey: null },
      });
    else await tx.reaction.deleteMany({ where: { ...where, reaction } });
  } else if (kind === 'cast_vote') {
    if (selected && value)
      await tx.characterVote.upsert({
        where: unique,
        create: { ...where, castId: value, source: 'MANUAL' },
        update: { castId: value, source: 'MANUAL', sourceKey: null },
      });
    else
      await tx.characterVote.deleteMany({
        where: { ...where, ...(value == null ? {} : { castId: value }) },
      });
  } else if (kind === 'watch_device') {
    const data = {
      device: selected ? (value as any) : null,
      deviceSource: selected ? ('MANUAL' as const) : null,
    };
    const selectedWhere = {
      ...where,
      ...(!selected && value != null ? { device: value as any } : {}),
    };
    if (target.episodeId) await tx.userEpisodeStatus.updateMany({ where: selectedWhere, data });
    else await tx.userMovieStatus.updateMany({ where: selectedWhere, data });
  } else throw new BadRequestException('Unsupported local vote');
}
