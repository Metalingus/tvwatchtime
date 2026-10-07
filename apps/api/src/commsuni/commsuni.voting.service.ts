import { isLegacyClientRequest } from '../common/client-capabilities';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ConversationType,
  EpisodeInteractionsDto,
  CommsUniOptionDto,
  CommsUniEngagementDto,
  CommsUniEngagementKind,
  VoteSectionDto,
  ReactionVoteSectionDto,
  CharacterVoteSectionDto,
} from '@tvwatch/shared';
import type { CommsUniVoteReceipt } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { CommsUniClient, CommsUniError } from './commsuni.client';
import { CommsUniReadService } from './commsuni.read.service';
import { acknowledgedCounts, voteActorDigest } from './commsuni.vote-receipts';
import type { CastOptionDto } from './commsuni.option-mapping';

type Counts = Map<string, number>;

/**
 * Shared engagement counts per title (provider guide §8): a short cache deduplicates bursts of
 * reads, and the last good copy is served read-only while the provider answers 429/5xx, instead
 * of dropping every screen back to local-only counts. Viewer flags are stripped before caching,
 * so a copy can be shown to any user (the merge reads each viewer's own state from our DB).
 */
const ENGAGEMENT_FRESH_MS = 60_000;
const ENGAGEMENT_FALLBACK_SECONDS = 6 * 60 * 60;

function anonymousEngagement(data: CommsUniEngagementDto): CommsUniEngagementDto {
  return {
    ...data,
    rating: data.rating ? { ...data.rating, viewerRating: null } : data.rating,
    sections: data.sections.map((section) => ({
      ...section,
      options: section.options.map((option) => ({
        ...option,
        selected: false,
        localSelected: undefined,
      })),
    })),
  };
}

/** Keep the frozen archive intact. Only known native contributions can be deducted. */
export function providerCounts(options: CommsUniOptionDto[], acknowledged: Counts): Counts | null {
  if (!options.length) return null;
  const result = new Map<string, number>();
  for (const option of options) {
    if (result.has(option.key) || !Number.isSafeInteger(option.count) || option.count < 0)
      return null;
    const subtract = acknowledged.get(option.key) ?? 0;
    if (subtract && (option.nativeCount == null || option.archivedCount == null)) return null;
    if (option.nativeCount != null && option.archivedCount != null) {
      if (option.nativeCount + option.archivedCount !== option.count) return null;
      result.set(option.key, option.archivedCount + Math.max(0, option.nativeCount - subtract));
    } else result.set(option.key, option.count);
  }
  return result;
}

function mergedOptions(
  local: VoteSectionDto['options'],
  remote: CommsUniOptionDto[],
  manual: Counts,
  acknowledged: Counts,
): VoteSectionDto['options'] | null {
  const counts = providerCounts(remote, acknowledged);
  if (!counts) return null;
  const allowed = new Set(local.map((option) => option.value));
  const byValue = new Map<string, number>();
  for (const option of remote) {
    if (!option.localValue || !allowed.has(option.localValue) || byValue.has(option.localValue))
      return null;
    byValue.set(option.localValue, counts.get(option.key)!);
  }
  return local.map((option) => ({
    ...option,
    count: (byValue.get(option.value) ?? 0) + (manual.get(option.value) ?? 0),
  }));
}

export function sharedVoteSection(
  local: VoteSectionDto,
  remote: CommsUniOptionDto[],
  manual: Counts,
  manualVote: string | null,
  acknowledged: Counts = new Map(),
): VoteSectionDto {
  const options = mergedOptions(local.options, remote, manual, acknowledged);
  if (!options) return local;
  return {
    ...local,
    options,
    total: options.reduce((sum, option) => sum + option.count, 0),
    countedUserVote: manualVote,
    aggregateSource: 'commsuni',
  };
}

export function sharedReactionSection(
  local: ReactionVoteSectionDto,
  remote: CommsUniOptionDto[],
  manual: Counts,
  manualVotes: string[],
  acknowledged: Counts = new Map(),
): ReactionVoteSectionDto {
  const options = mergedOptions(local.options, remote, manual, acknowledged);
  if (!options) return local;
  return {
    ...local,
    options,
    total: options.reduce((sum, option) => sum + option.count, 0),
    countedUserVotes: manualVotes,
    totalKind: 'selections',
    aggregateSource: 'commsuni',
  };
}

/**
 * The archive returns one TV Time vote set under several keys (`actor:<n>`, `cast:<slug>`,
 * `cast:<slug>-<hash>`), each with the same performer, role and count. Rows that agree on all
 * three are one set of votes and are counted once; rows that differ are distinct and add up.
 */
const archiveSignature = (option: CommsUniOptionDto, count: number) =>
  `${option.label.trim().toLowerCase()}|${(option.role ?? '').trim().toLowerCase()}|${count}`;

export function sharedCharacterSection(
  local: CharacterVoteSectionDto,
  remote: CastOptionDto[],
  manual: Counts,
  manualVote: string | null,
  acknowledged: Counts = new Map(),
): CharacterVoteSectionDto {
  const counts = providerCounts(remote, acknowledged);
  if (!counts) return local;
  const byCredit = new Map<string, number>(manual);
  // Archived counts shown on the matching votable credit, de-duplicated per credit.
  const archivedByCredit = new Map<string, Map<string, number>>();
  const unmapped = new Map<
    string,
    NonNullable<CharacterVoteSectionDto['unmappedOptions']>[number]
  >();
  for (const option of [...remote].sort((a, b) => a.key.localeCompare(b.key))) {
    const count = counts.get(option.key)!;
    if (option.localValue)
      byCredit.set(option.localValue, (byCredit.get(option.localValue) ?? 0) + count);
    else if (option.archivedCreditId && count) {
      const sets = archivedByCredit.get(option.archivedCreditId) ?? new Map<string, number>();
      sets.set(archiveSignature(option, count), count);
      archivedByCredit.set(option.archivedCreditId, sets);
    } else if (count && option.label.trim() && option.label !== option.key) {
      const signature = archiveSignature(option, count);
      if (!unmapped.has(signature))
        unmapped.set(signature, {
          key: option.key,
          name: option.label,
          character: option.role ?? null,
          imageUrl: option.imageUrl,
          count,
        });
    }
  }
  for (const [creditId, sets] of archivedByCredit) {
    const archived = [...sets.values()].reduce((sum, count) => sum + count, 0);
    byCredit.set(creditId, (byCredit.get(creditId) ?? 0) + archived);
  }
  const unmappedOptions = [...unmapped.values()];
  const options = [...byCredit]
    .map(([castId, count]) => ({ castId, count }))
    .sort((a, b) => a.castId.localeCompare(b.castId));
  unmappedOptions.sort((a, b) => a.key.localeCompare(b.key));
  return {
    ...local,
    options,
    unmappedOptions,
    total:
      options.reduce((sum, option) => sum + option.count, 0) +
      unmappedOptions.reduce((sum, option) => sum + option.count, 0),
    countedUserVote: manualVote,
    aggregateSource: 'commsuni',
  };
}

@Injectable()
export class CommsUniVotingService {
  private readonly logger = new Logger(CommsUniVotingService.name);

  constructor(
    private readonly client: CommsUniClient,
    private readonly reads: CommsUniReadService,
    private readonly prisma: PrismaService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  private engagementKey(type: ConversationType, id: string) {
    return `commsuni:engagement:v1:${this.client.scope}:${type}:${id}`;
  }

  /** Provider counts for a title: fresh cache (reads only), live read, or outage fallback. */
  private async sharedEngagement(
    userId: string,
    type: ConversationType,
    id: string,
    useCache: boolean,
  ): Promise<{ data: CommsUniEngagementDto; anonymous: boolean }> {
    const key = this.engagementKey(type, id);
    const cached = this.redis
      ? await this.redis.get<{ at: number; data: CommsUniEngagementDto }>(key).catch(() => null)
      : null;
    if (useCache && cached && Date.now() - cached.at < ENGAGEMENT_FRESH_MS)
      return { data: cached.data, anonymous: true };
    try {
      const data = await this.reads.engagement(userId, type, id, false);
      if (data.available && this.redis)
        await this.redis
          .set(
            key,
            { at: Date.now(), data: anonymousEngagement(data) },
            ENGAGEMENT_FALLBACK_SECONDS,
          )
          .catch(() => undefined);
      return { data, anonymous: false };
    } catch (error) {
      if (cached && error instanceof CommsUniError && error.retryable)
        return { data: cached.data, anonymous: true };
      throw error;
    }
  }

  private async receipts(shared: CommsUniEngagementDto): Promise<CommsUniVoteReceipt[]> {
    if (!shared.entity) throw Error('Missing verified engagement entity');
    const { type, id, reference } = shared.entity;
    try {
      return await this.prisma.commsUniVoteReceipt.findMany({
        where: {
          scope: this.client.voteScope,
          entityType: type,
          OR: [{ entityId: id }, { reference }],
        },
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2021') throw error;
      // Staggered read-only rollout: no receipt is needed when this installation has never
      // attempted a vote delivery. Sending is independently blocked on missing receipt storage.
      const attempted = await this.prisma.commsUniOutbox.findFirst({
        where: {
          identity: { scope: this.client.scope },
          method: 'SELECTION',
          firstAttemptAt: { not: null },
        },
        select: { id: true },
      });
      if (attempted) throw error;
      return [];
    }
  }

  async merge<T extends Partial<EpisodeInteractionsDto>>(
    userId: string | undefined,
    type: ConversationType,
    id: string,
    local: T,
    options: { cached?: boolean } = {},
  ): Promise<T> {
    if (isLegacyClientRequest() || !userId || !this.client.enabled) return local;
    try {
      const { data: shared, anonymous } = await this.sharedEngagement(
        userId,
        type,
        id,
        options.cached === true,
      );
      if (!shared.available) return local;
      // A request may have reached the provider before its local receipt was committed.
      // During that uncertainty, show the existing local section rather than double-counting it.
      const unresolved = await this.prisma.commsUniOutbox.findMany({
        where: {
          identity: { scope: this.client.scope },
          method: 'SELECTION',
          firstAttemptAt: { not: null },
          state: { notIn: ['SYNCED', 'DUPLICATE_REPORT'] },
          OR: [
            { target: { path: ['threadId'], equals: id } },
            ...(shared.entity
              ? [
                  {
                    path: {
                      startsWith:
                        '/entities/' + shared.entity.type + '/' + shared.entity.id + '/engagement/',
                    },
                  },
                ]
              : []),
          ],
        },
        select: {
          path: true,
          target: true,
          sequence: true,
          identity: { select: { userId: true } },
        },
      });
      const where = type === 'EPISODE' ? { episodeId: id } : { mediaId: id };
      const manualWhere = { ...where, source: 'MANUAL' as const };
      const viewerWhere = { ...manualWhere, userId };
      const [
        receipts,
        ratings,
        reactions,
        devices,
        characters,
        rating,
        reaction,
        device,
        character,
      ] = await Promise.all([
        this.receipts(shared),
        local.rating
          ? this.prisma.rating.groupBy({
              by: ['rating'],
              where: manualWhere,
              _count: { _all: true },
            })
          : [],
        local.reaction
          ? this.prisma.reaction.groupBy({
              by: ['reaction'],
              where: manualWhere,
              _count: { _all: true },
            })
          : [],
        local.device && type === 'EPISODE'
          ? this.prisma.userEpisodeStatus.groupBy({
              by: ['device'],
              where: { episodeId: id, deviceSource: 'MANUAL', device: { not: null } },
              _count: { _all: true },
            })
          : [],
        local.character
          ? this.prisma.characterVote.groupBy({
              by: ['castId'],
              where: manualWhere,
              _count: { _all: true },
            })
          : [],
        local.rating
          ? this.prisma.rating.findFirst({ where: viewerWhere, select: { rating: true } })
          : null,
        local.reaction
          ? this.prisma.reaction.findMany({ where: viewerWhere, select: { reaction: true } })
          : [],
        local.device && type === 'EPISODE'
          ? this.prisma.userEpisodeStatus.findFirst({
              where: { userId, episodeId: id, deviceSource: 'MANUAL' },
              select: { device: true },
            })
          : null,
        local.character
          ? this.prisma.characterVote.findFirst({
              where: viewerWhere,
              select: { castId: true },
            })
          : null,
      ]);
      const unresolvedKinds = new Set(
        unresolved
          .filter((row) => {
            if ((row.target as Record<string, unknown> | null)?.deliveryUncertain === false)
              return false;
            const kind = row.path.split('/').pop();
            const user = row.identity?.userId;
            const actorDigest = user ? voteActorDigest(this.client.actor(user)) : null;
            return (
              !actorDigest ||
              !receipts.some(
                (receipt) =>
                  receipt.kind === kind &&
                  receipt.actorDigest === actorDigest &&
                  receipt.sequence > row.sequence,
              )
            );
          })
          .map((row) => row.path.split('/').pop()),
      );
      const section = (kind: CommsUniEngagementKind) =>
        shared.sections.find((item) => item.kind === kind)?.options ?? [];
      const acknowledged = (kind: CommsUniEngagementKind) =>
        acknowledgedCounts(receipts, kind, this.client.actor(userId), section(kind), anonymous);
      return {
        ...local,
        ...(local.rating && !unresolvedKinds.has('star_rating')
          ? {
              rating: sharedVoteSection(
                local.rating,
                section('star_rating'),
                new Map(ratings.map((row) => [String(row.rating), row._count._all])),
                rating && String(rating.rating) === local.rating.userVote
                  ? String(rating.rating)
                  : null,
                acknowledged('star_rating'),
              ),
            }
          : {}),
        ...(local.reaction && !unresolvedKinds.has('emotion')
          ? {
              reaction: sharedReactionSection(
                local.reaction,
                section('emotion'),
                new Map(reactions.map((row) => [row.reaction, row._count._all])),
                reaction
                  .map((row) => row.reaction)
                  .filter((value) => local.reaction!.userVotes.includes(value)),
                acknowledged('emotion'),
              ),
            }
          : {}),
        ...(local.device && !unresolvedKinds.has('watch_device')
          ? {
              device: sharedVoteSection(
                local.device,
                section('watch_device'),
                new Map(
                  devices.filter((row) => row.device).map((row) => [row.device!, row._count._all]),
                ),
                device?.device === local.device.userVote ? device.device : null,
                acknowledged('watch_device'),
              ),
            }
          : {}),
        ...(local.character && !unresolvedKinds.has('cast_vote')
          ? {
              character: sharedCharacterSection(
                local.character,
                section('cast_vote'),
                new Map(characters.map((row) => [row.castId, row._count._all])),
                character?.castId === local.character.userVote ? character.castId : null,
                acknowledged('cast_vote'),
              ),
            }
          : {}),
      };
    } catch (error) {
      // Shared counts are optional; say why the local section is shown instead.
      this.logger.warn(
        `Shared engagement unavailable for ${type} ${id}: ${(error as Error)?.message ?? error}`,
      );
      return local;
    }
  }
}
