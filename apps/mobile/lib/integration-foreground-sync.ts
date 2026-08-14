export const INTEGRATION_FOREGROUND_SYNC_THROTTLE_MS = 15 * 60_000;

export type ForegroundSyncStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<unknown>;
};

export function createIntegrationForegroundSyncCoordinator({
  storage,
  sync,
  now = Date.now,
}: {
  storage: ForegroundSyncStorage;
  sync: () => Promise<unknown>;
  now?: () => number;
}) {
  const inFlight = new Map<string, Promise<boolean>>();

  const runOnce = async (userId: string): Promise<boolean> => {
    const key = `integrationForegroundSync:${userId}`;
    const currentTime = now();
    let lastAttempt = Number.NaN;
    try {
      const stored = await storage.getItem(key);
      lastAttempt = stored === null ? Number.NaN : Number(stored);
    } catch {
      // The backend independently throttles foreground sync if local storage is unavailable.
    }
    if (
      Number.isFinite(lastAttempt) &&
      currentTime >= lastAttempt &&
      currentTime - lastAttempt < INTEGRATION_FOREGROUND_SYNC_THROTTLE_MS
    ) {
      return false;
    }

    await sync();
    // Only persist successful backend contact. A transient offline/API failure should retry on the
    // next foreground event; once reached, the backend independently protects every provider.
    try {
      await storage.setItem(key, String(currentTime));
    } catch {
      // Best effort only; the backend remains the authoritative throttle.
    }
    return true;
  };

  return {
    async run(userId: string): Promise<boolean> {
      const active = inFlight.get(userId);
      if (active) return active;
      const task = runOnce(userId);
      inFlight.set(userId, task);
      try {
        return await task;
      } finally {
        if (inFlight.get(userId) === task) inFlight.delete(userId);
      }
    },
  };
}
