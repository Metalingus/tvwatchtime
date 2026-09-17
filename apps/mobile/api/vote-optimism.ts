import type { EpisodeInteractionsDto } from '@tvwatch/shared';
import {
  applyVoteChange,
  type VoteSectionDto,
  type CharacterVoteSectionDto,
  type ReactionVoteSectionDto,
} from '@tvwatch/shared';

/** Recompute a generic section (device / rating / reaction) after a vote change. */
export function recomputeVoteSection(section: VoteSectionDto, to: string | null): VoteSectionDto {
  const shared = section.aggregateSource === 'commsuni';
  // Older API payloads do not say which local contribution is already counted.
  if (shared && !('countedUserVote' in section)) return { ...section, userVote: to };
  const from = shared ? (section.countedUserVote ?? null) : section.userVote;
  const { options, total } = applyVoteChange(section.options, section.total, from, to);
  return { ...section, userVote: to, total, options, ...(shared ? { countedUserVote: to } : {}) };
}

/**
 * Recompute the multi-select reaction section after toggling one reaction.
 * `total` (distinct users) only changes when the user crosses zero<->nonzero.
 */
export function recomputeReactionSection(
  section: ReactionVoteSectionDto,
  toggle: string,
): ReactionVoteSectionDto {
  // Defensive: tolerate an older single-select payload where userVotes is absent.
  const prevVotes = section.userVotes ?? [];
  const has = prevVotes.includes(toggle);
  const userVotes = has ? prevVotes.filter((v) => v !== toggle) : [...prevVotes, toggle];
  if (section.aggregateSource === 'commsuni') {
    if (!section.countedUserVotes) return { ...section, userVotes };
    const counted = section.countedUserVotes.includes(toggle);
    const countedUserVotes = has
      ? section.countedUserVotes.filter((value) => value !== toggle)
      : [...section.countedUserVotes.filter((value) => value !== toggle), toggle];
    const options = section.options.map((option) =>
      option.value === toggle
        ? { ...option, count: Math.max(0, option.count + (has ? (counted ? -1 : 0) : 1)) }
        : option,
    );
    return {
      ...section,
      userVotes,
      countedUserVotes,
      options,
      total: options.reduce((sum, option) => sum + option.count, 0),
    };
  }
  const hadAny = prevVotes.length > 0;
  const hasAnyNow = userVotes.length > 0;

  const options = section.options.map((o) => {
    if (o.value !== toggle) return o;
    return { ...o, count: Math.max(0, o.count + (has ? -1 : 1)) };
  });

  let total = section.total;
  if (!hadAny && hasAnyNow) total += 1;
  if (hadAny && !hasAnyNow) total = Math.max(0, total - 1);

  return { userVotes, total, options };
}

/** Recompute the character section (options keyed by castId, not `value`). */
export function recomputeCharacterSection(
  section: CharacterVoteSectionDto,
  to: string | null,
): CharacterVoteSectionDto {
  const shared = section.aggregateSource === 'commsuni';
  if (shared && !('countedUserVote' in section)) return { ...section, userVote: to };
  const from = shared ? (section.countedUserVote ?? null) : section.userVote;
  const valueOpts = section.options.map((o) => ({ value: o.castId, count: o.count }));
  const { options, total } = applyVoteChange(valueOpts, section.total, from, to);
  return {
    ...section,
    ...(shared ? { countedUserVote: to } : {}),
    userVote: to,
    total,
    options: options
      .map((o) => ({ castId: o.value, count: o.count }))
      .sort((a, b) => a.castId.localeCompare(b.castId)),
  };
}

/** A failed vote restores its category only; concurrent successful categories and metadata survive. */
export function restoreVoteSection<T extends { interactions: Partial<EpisodeInteractionsDto> }>(
  current: T | undefined,
  previous: T,
  section: keyof EpisodeInteractionsDto,
): T | undefined {
  if (!current) return current;
  return {
    ...current,
    interactions: { ...current.interactions, [section]: previous.interactions[section] },
  };
}
