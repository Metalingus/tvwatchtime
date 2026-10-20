import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from '../uuid';

const CUSTOMER_ID_KEY = 'tvwatch.giphyCustomerId';

let cachedCustomerId: string | null = null;

/**
 * Returns a stable anonymous GIPHY customer id, generating + persisting it on
 * first use. Stored only on the device (AsyncStorage works on native and web);
 * never written to our backend.
 */
export async function getCustomerId(): Promise<string> {
  if (cachedCustomerId) return cachedCustomerId;
  let id = await AsyncStorage.getItem(CUSTOMER_ID_KEY);
  if (!id) {
    id = randomUUID();
    await AsyncStorage.setItem(CUSTOMER_ID_KEY, id);
  }
  cachedCustomerId = id;
  return id;
}

/**
 * Best-effort fire-and-forget of a GIPHY analytics URL. Appends the required
 * customer id + current millisecond timestamp. Never throws; never blocks the
 * UI or prevents GIF selection / comment posting.
 */
export function fireAnalytics(url?: string | null): void {
  if (!url || typeof url !== 'string') return;
  void (async () => {
    try {
      const ts = Date.now().toString();
      const sep = url.includes('?') ? '&' : '?';
      const full = `${url}${sep}ts=${ts}&customer_id=${encodeURIComponent(await getCustomerId())}`;
      await fetch(full, { method: 'GET' });
    } catch {
      // Analytics failures are non-fatal.
    }
  })();
}
