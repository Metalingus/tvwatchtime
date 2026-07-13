import React, { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';

/**
 * Whole-number percentage that fades in/out with `reveal` without remounting.
 * Always mounted (so toggling reveal or updating the value never re-triggers a
 * mount animation — that remount was the source of the all-tiles flicker).
 */
export function VotingPercentage({ percent, reveal }: { percent: number; reveal: boolean }) {
  const { tokens } = useAppearance();
  const fade = useRef(new Animated.Value(reveal ? 1 : 0)).current;
  useEffect(() => {
    const a = Animated.timing(fade, { toValue: reveal ? 1 : 0, duration: 200, useNativeDriver: true });
    a.start();
    return () => a.stop();
  }, [reveal, fade]);
  return (
    <Animated.View
      style={{
        opacity: fade,
        transform: [{ translateY: fade.interpolate({ inputRange: [0, 1], outputRange: [3, 0] }) }],
      }}
    >
      <T variant="micro" style={{ color: tokens.textMuted, fontWeight: '700' }}>
        {percent}%
      </T>
    </Animated.View>
  );
}
