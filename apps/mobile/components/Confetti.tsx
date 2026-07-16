import React, { useRef, useState, useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import ConfettiCannon from 'react-native-confetti-cannon';

const COLORS = ['#FFD60A', '#22C55E', '#FF6B6B', '#4ECDC4', '#FFD93D', '#A78BFA', '#60A5FA', '#F472B6'];

/**
 * Hook that triggers confetti from both sides of the screen.
 * Call `fire()` to start.
 *
 * Usage:
 * const { confettiEl, fire } = useConfetti();
 * if (someCondition) fire();
 * return <Screen>{confettiEl}...</Screen>;
 */
export function useConfetti() {
  const [shoot, setShoot] = useState(0);

  const fire = useCallback(() => {
    setShoot((s) => s + 1);
  }, []);

  const confettiEl = shoot > 0 ? (
    <View style={styles.overlay} pointerEvents="none">
      <ConfettiCannon
        key={`l_${shoot}`}
        count={150}
        origin={{ x: -20, y: 0 }}
        explosionSpeed={800}
        fallSpeed={3000}
        fadeOut={true}
        colors={COLORS}
      />
      <ConfettiCannon
        key={`r_${shoot}`}
        count={150}
        origin={{ x: 500, y: 0 }}
        explosionSpeed={800}
        fallSpeed={3000}
        fadeOut={true}
        colors={COLORS}
      />
    </View>
  ) : null;

  return { confettiEl, fire };
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 9999,
    elevation: 9999,
  },
});
