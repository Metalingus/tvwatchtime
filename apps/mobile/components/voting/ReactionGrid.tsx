import React from 'react';
import { useWindowDimensions, View } from 'react-native';
import type { TFunction } from 'i18next';
import type { ReactionVoteSectionDto } from '@tvwatch/shared';
import { SelectableIconTile } from './SelectableIconTile';
import { REACTION_META, REACTION_ORDER, composeOptionLabel, reactionPercents, type ReactionTypeKey } from './meta';
import { spacing } from '../../theme/theme';

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function ReactionGrid({
  section,
  onSelect,
  pending,
  t,
}: {
  section: ReactionVoteSectionDto;
  onSelect: (value: ReactionTypeKey) => void;
  pending: boolean;
  t: TFunction;
}) {
  const { width } = useWindowDimensions();
  // Defensive: tolerate an older single-select backend payload (userVote) so a
  // version skew can't crash the grid or self-revert selections.
  const userVotes = section.userVotes ?? [];
  const percents = reactionPercents(section);
  // Multi-select: reveal once the user has picked at least one reaction.
  const reveal = userVotes.length > 0;
  const cols = width < 360 ? 3 : width >= 768 ? 6 : 4;
  const gap = spacing.xs;

  const rows = chunk(REACTION_ORDER, cols);
  return (
    <View>
      {rows.map((row, ri) => {
        const isLast = ri === rows.length - 1;
        return (
          <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: isLast ? 0 : gap }}>
            {row.map((key) => {
              const meta = REACTION_META[key];
              const selected = userVotes.includes(key);
              return (
                <SelectableIconTile
                  key={key}
                  emoji={meta.emoji}
                  label={t(meta.labelKey)}
                  selected={selected}
                  reveal={reveal}
                  percent={percents.get(key)}
                  disabled={pending}
                  toggle
                  onPress={() => onSelect(key)}
                  style={{ flex: 1, marginHorizontal: gap / 2 }}
                  iconSize={24}
                  accessibilityLabel={composeOptionLabel(t, t(meta.labelKey), selected, reveal, percents.get(key))}
                />
              );
            })}
            {Array.from({ length: cols - row.length }).map((_, fi) => (
              <View key={'f' + fi} style={{ flex: 1, marginHorizontal: gap / 2 }} />
            ))}
          </View>
        );
      })}
    </View>
  );
}
