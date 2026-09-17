import type {
  ConversationCountDto,
  EpisodeDetailDto,
  EpisodeInteractionsDto,
  MovieDetailDto,
  ShowDetailDto,
} from '@tvwatch/shared';

export type MediaDetail = ShowDetailDto | MovieDetailDto | EpisodeDetailDto;
export type DetailInteractions = Partial<EpisodeInteractionsDto>;
const sections = ['rating', 'reaction', 'character', 'device'] as const;

function withCharacterCounts<T extends MediaDetail>(detail: T): T {
  const character = (detail.interactions as DetailInteractions)?.character;
  if (!character || !detail.cast) return detail;
  const counts = new Map(character.options.map((option) => [option.castId, option.count]));
  return {
    ...detail,
    cast: detail.cast.map((member) => ({
      ...member,
      votes: counts.get('creditId' in member ? member.creditId : '') ?? 0,
    })),
  };
}

function sameSelection(
  a: NonNullable<DetailInteractions[keyof DetailInteractions]>,
  b: NonNullable<DetailInteractions[keyof DetailInteractions]>,
) {
  if ('userVotes' in a && 'userVotes' in b) {
    return (
      a.userVotes.length === b.userVotes.length &&
      a.userVotes.every((value) => b.userVotes.includes(value))
    );
  }
  return 'userVote' in a && 'userVote' in b && a.userVote === b.userVote;
}

/** Artwork polling refreshes local fields without undoing shared totals already on screen. */
export function mergeLocalDetail<T extends MediaDetail>(previous: T | undefined, fresh: T): T {
  if (!fresh || !previous || previous.id !== fresh.id || !fresh.communityDetailsDeferred)
    return fresh;
  const interactions: DetailInteractions = { ...fresh.interactions };
  for (const key of sections) {
    const before = (previous.interactions as DetailInteractions)?.[key];
    const next = interactions[key];
    if (before?.aggregateSource === 'commsuni' && next && sameSelection(before, next)) {
      // The key and section retain their original pairing.
      Object.assign(interactions, { [key]: before });
    }
  }
  return withCharacterCounts({
    ...fresh,
    interactions,
    ...(previous.commentsCountSource === 'commsuni'
      ? {
          commentsCount: previous.commentsCount,
          commentsCountApproximate: previous.commentsCountApproximate,
          commentsCountSource: previous.commentsCountSource,
        }
      : {}),
  } as T);
}

/** Apply only sections untouched since the request began, preserving optimistic vote changes. */
export function applyCommunityInteractions<T extends MediaDetail>(
  current: T | undefined,
  baseline: T | undefined,
  threadId: string,
  incoming: DetailInteractions,
): T | undefined {
  if (!current || !baseline || current.id !== threadId || baseline.id !== threadId) return current;
  const interactions: DetailInteractions = { ...current.interactions };
  let changed = false;
  for (const key of sections) {
    const value = incoming[key];
    if (
      value?.aggregateSource === 'commsuni' &&
      interactions[key] === (baseline.interactions as DetailInteractions)?.[key]
    ) {
      Object.assign(interactions, { [key]: value });
      changed = true;
    }
  }
  return changed ? withCharacterCounts({ ...current, interactions } as T) : current;
}

/**
 * A local detail refresh may land while this independent count request is in flight.
 * Accept the shared total for the same thread even if that refresh changed the local
 * count; request cancellation/scope checks reject stale requests before this updater.
 */
export function applyCommunityCount<T extends MediaDetail>(
  current: T | undefined,
  baseline: T | undefined,
  incoming: ConversationCountDto,
): T | undefined {
  if (
    !current ||
    !baseline ||
    current.id !== incoming.threadId ||
    baseline.id !== incoming.threadId ||
    incoming.source !== 'commsuni'
  )
    return current;
  return {
    ...current,
    commentsCount: incoming.total,
    commentsCountApproximate: incoming.approximate,
    commentsCountSource: incoming.source,
  };
}
