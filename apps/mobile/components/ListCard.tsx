import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { PosterImage, T } from './primitives';
import { colors, radius, spacing } from '../theme/theme';

export function ListCard({ item, onPress, style }: { item: any; onPress?: () => void; style?: any }) {
  return (
    <Pressable onPress={onPress} style={[styles.card, style]}>
      <PosterImage
        uri={item.coverUrl}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.85)']}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.content}>
        <T variant="caption" style={styles.title} numberOfLines={2}>{item.title}</T>
        {item.description ? <T variant="micro" style={styles.desc} numberOfLines={1}>{item.description}</T> : null}
        <T variant="micro" style={styles.counts}>
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
    backgroundColor: colors.surface,
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
    color: '#fff',
    fontWeight: '700',
  },
  desc: {
    color: 'rgba(255,255,255,0.6)',
    marginTop: 2,
  },
  counts: {
    color: 'rgba(255,255,255,0.8)',
    marginTop: 4,
  },
});
