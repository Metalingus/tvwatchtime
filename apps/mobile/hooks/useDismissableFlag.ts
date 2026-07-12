import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A boolean flag persisted in AsyncStorage. Returns `visible` as:
 *  - `null` while loading (so callers can avoid a flash)
 *  - `true` until `dismiss()` is called
 *  - `false` permanently afterwards (per device)
 *
 * Version the `key` (e.g. `banner:lists_import_v1`) to re-show a banner later.
 */
export function useDismissableFlag(key: string) {
  const [visible, setVisible] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    AsyncStorage.getItem(key)
      .then((v) => {
        if (mounted) setVisible(v !== '1');
      })
      .catch(() => {
        if (mounted) setVisible(true);
      });
    return () => {
      mounted = false;
    };
  }, [key]);

  const dismiss = useCallback(() => {
    setVisible(false);
    AsyncStorage.setItem(key, '1').catch(() => undefined);
  }, [key]);

  return { visible, dismiss };
}
