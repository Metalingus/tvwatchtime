import React from 'react';
import { View } from 'react-native';
import type { TFunction } from 'i18next';
import type { VoteSectionDto } from '@tvwatch/shared';
import { SelectableIconTile } from './SelectableIconTile';
import { DEVICE_META, DEVICE_ORDER, composeOptionLabel, sectionPercents } from './meta';

export function DeviceTiles({
  section,
  onSelect,
  pending,
  t,
}: {
  section: VoteSectionDto;
  onSelect: (value: 'PHONE' | 'TABLET' | 'COMPUTER' | 'TV') => void;
  pending: boolean;
  t: TFunction;
}) {
  const percents = sectionPercents(section);
  const reveal = section.userVote !== null;
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
      {DEVICE_ORDER.map((key) => {
        const meta = DEVICE_META[key];
        const selected = section.userVote === key;
        return (
          <SelectableIconTile
            key={key}
            icon={meta.icon}
            label={t(meta.labelKey)}
            selected={selected}
            reveal={reveal}
            percent={percents.get(key)}
            disabled={pending}
            onPress={() => onSelect(key)}
            style={{ flex: 1, marginHorizontal: 2 }}
            accessibilityLabel={composeOptionLabel(t, t(meta.labelKey), selected, reveal, percents.get(key))}
          />
        );
      })}
    </View>
  );
}
