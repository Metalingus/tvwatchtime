import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { PosterImage, T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';

export function ListCard({ item, onPress, style }: { item: any; onPress?: () => void; style?: any }) {
  const { tokens } = useAppearance();
  return (
    <Pressable onPress={onPress} style={[styles.card, { backgroundColor: tokens.surface }, style]}>
      <PosterImage
        uri={item.coverUrl}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={tokens.mediaGradient}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.content}>
        <T variant="caption" style={[styles.title, { color: tokens.mediaText }]} numberOfLines={2}>{item.title}</T>
        {item.description ? <T variant="micro" style={[styles.desc, { color: tokens.mediaText }]} numberOfLines={1}>{item.description}</T> : null}
        <T variant="micro" style={[styles.counts, { color: tokens.mediaText }]}>
          {item.movieCount > 0 ? `🎬 ${item.movieCount}` : ''}{' '}
          {item.showCount > 0 ? `📺 ${item.showCount}` : ''}
          {!item.movieCount && !item.showCount ? 'Empty' : ''}
        </T>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: 160,
    height: 220,
    borderRadius: radius.md,
    overflow: 'hidden',
    marginRight: spacing.md,
  },
  content: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    padding: spacing.sm,
  },
  title: {
    fontWeight: '700',
  },
  desc: {
    marginTop: 2,
  },
  counts: {
    marginTop: 4,
  },
});
