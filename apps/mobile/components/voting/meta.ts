import { Ionicons } from '@expo/vector-icons';
import { computePercentages, type ReactionVoteSectionDto, type VoteSectionDto } from '@tvwatch/shared';

export type ReactionTypeKey =
  | 'SHOCKED' | 'FRUSTRATED' | 'SAD' | 'REFLECTIVE' | 'TOUCHED' | 'AMUSED'
  | 'SCARED' | 'BORED' | 'UNDERSTANDING' | 'THRILLED' | 'CONFUSED' | 'TENSE';

export const REACTION_ORDER: ReactionTypeKey[] = [
  'SHOCKED', 'FRUSTRATED', 'SAD', 'REFLECTIVE', 'TOUCHED', 'AMUSED',
  'SCARED', 'BORED', 'UNDERSTANDING', 'THRILLED', 'CONFUSED', 'TENSE',
];

export const REACTION_META: Record<ReactionTypeKey, { emoji: string; labelKey: string }> = {
  SHOCKED: { emoji: '😲', labelKey: 'episode:reactions.Shocked' },
  FRUSTRATED: { emoji: '😤', labelKey: 'episode:reactions.Frustrated' },
  SAD: { emoji: '😢', labelKey: 'episode:reactions.Sad' },
  REFLECTIVE: { emoji: '🤔', labelKey: 'episode:reactions.Reflective' },
  TOUCHED: { emoji: '🥹', labelKey: 'episode:reactions.Touched' },
  AMUSED: { emoji: '😄', labelKey: 'episode:reactions.Amused' },
  SCARED: { emoji: '😱', labelKey: 'episode:reactions.Scared' },
  BORED: { emoji: '😑', labelKey: 'episode:reactions.Bored' },
  UNDERSTANDING: { emoji: '💡', labelKey: 'episode:reactions.Understanding' },
  THRILLED: { emoji: '🤩', labelKey: 'episode:reactions.Thrilled' },
  CONFUSED: { emoji: '😕', labelKey: 'episode:reactions.Confused' },
  TENSE: { emoji: '😬', labelKey: 'episode:reactions.Tense' },
};

export type DeviceKey = 'PHONE' | 'TABLET' | 'COMPUTER' | 'TV';

export const DEVICE_ORDER: DeviceKey[] = ['PHONE', 'TABLET', 'COMPUTER', 'TV'];

export const DEVICE_META: Record<DeviceKey, { icon: keyof typeof Ionicons.glyphMap; labelKey: string }> = {
  PHONE: { icon: 'phone-portrait-outline', labelKey: 'episode:devices.Phone' },
  TABLET: { icon: 'tablet-portrait-outline', labelKey: 'episode:devices.Tablet' },
  COMPUTER: { icon: 'laptop-outline', labelKey: 'episode:devices.Computer' },
  TV: { icon: 'tv-outline', labelKey: 'episode:devices.TV' },
};

export const RATING_ORDER = [1, 2, 3, 4, 5] as const;

export const RATING_META: Record<number, string> = {
  1: 'episode:ratingBad',
  2: 'episode:ratingOK',
  3: 'episode:ratingGood',
  4: 'episode:ratingGreat',
  5: 'episode:ratingWow',
};

/** Map option value -> whole-number percent for a section (largest-remainder, sums to 100). */
export function sectionPercents(section: VoteSectionDto): Map<string, number> {
  const computed = computePercentages(section.options, section.total);
  return new Map(computed.map((o) => [o.value, o.percent]));
}

/**
 * Map option value -> whole-number percent for the multi-select reaction section.
 * Each reaction is rounded independently (a user may hold several, so percents
 * are "% of reactors" and need not sum to 100).
 */
export function reactionPercents(section: ReactionVoteSectionDto): Map<string, number> {
  const { total } = section;
  return new Map(
    section.options.map((o) => [o.value, total > 0 ? Math.round((o.count * 100) / total) : 0]),
  );
}

type TFunc = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Compose a screen-reader label for a voting option:
 * "<name>[, selected][, <n> percent]". Words are localized via the a11y keys.
 */
export function composeOptionLabel(
  t: TFunc,
  name: string,
  selected: boolean,
  reveal: boolean,
  percent: number | undefined,
): string {
  const parts: string[] = [name];
  if (selected) parts.push(t('episode:a11y.selected'));
  if (reveal && percent != null) parts.push(t('episode:a11y.percent', { value: percent }));
  return parts.join(', ');
}
