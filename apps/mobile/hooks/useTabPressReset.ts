import { useEffect } from 'react';
import { useNavigation } from 'expo-router';

/**
 * Calls `onReset` when the user taps the already-focused tab.
 * Use it to scroll back to the top / return a screen to its default state.
 */
export function useTabPressReset(onReset: () => void) {
  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('tabPress', (e: any) => {
      if (navigation.isFocused()) {
        e.preventDefault?.();
        onReset();
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigation]);
}
