import React from 'react';
import { View } from 'react-native';
import { Skeleton } from '../primitives';
import { radius, spacing } from '../../theme/theme';

/** Placeholder tile grid shown while a voting section is loading. */
export function VoteLoadingState({ cols = 4, rows = 1 }: { cols?: number; rows?: number }) {
  const cells = Array.from({ length: cols * rows });
  const rowCells: typeof cells[] = [];
  for (let i = 0; i < cells.length; i += cols) rowCells.push(cells.slice(i, i + cols));
  return (
    <View>
      {rowCells.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: ri < rowCells.length - 1 ? spacing.sm : 0 }}>
          {row.map((_, ci) => (
            <View
              key={ci}
              style={{
                flex: 1,
                marginHorizontal: 2,
                height: 72,
                borderRadius: radius.md,
                overflow: 'hidden',
              }}
            >
              <Skeleton style={{ width: '100%', height: '100%' }} />
            </View>
          ))}
        </View>
      ))}
    </View>
  );
}
