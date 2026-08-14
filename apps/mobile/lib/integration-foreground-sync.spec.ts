import {
  createIntegrationForegroundSyncCoordinator,
  INTEGRATION_FOREGROUND_SYNC_THROTTLE_MS,
} from './integration-foreground-sync';

describe('integration foreground sync coordinator', () => {
  it('runs once per user within the 15-minute window', async () => {
    const values = new Map<string, string>();
    let currentTime = 1_000_000;
    const sync = jest.fn().mockResolvedValue(undefined);
    const coordinator = createIntegrationForegroundSyncCoordinator({
      storage: {
        getItem: jest.fn(async (key) => values.get(key) ?? null),
        setItem: jest.fn(async (key, value) => values.set(key, value)),
      },
      sync,
      now: () => currentTime,
    });

    await expect(coordinator.run('user-1')).resolves.toBe(true);
    currentTime += INTEGRATION_FOREGROUND_SYNC_THROTTLE_MS - 1;
    await expect(coordinator.run('user-1')).resolves.toBe(false);
    await expect(coordinator.run('user-2')).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);

    currentTime += 1;
    await expect(coordinator.run('user-1')).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(3);
  });

  it('deduplicates concurrent foreground events for the same user', async () => {
    const sync = jest.fn().mockResolvedValue(undefined);
    const coordinator = createIntegrationForegroundSyncCoordinator({
      storage: {
        getItem: jest.fn().mockResolvedValue(null),
        setItem: jest.fn().mockResolvedValue(undefined),
      },
      sync,
      now: () => 1_000_000,
    });

    await expect(
      Promise.all([coordinator.run('user-1'), coordinator.run('user-1')]),
    ).resolves.toEqual([true, true]);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not throttle a foreground retry when the backend could not be reached', async () => {
    const sync = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const values = new Map<string, string>();
    const coordinator = createIntegrationForegroundSyncCoordinator({
      storage: {
        getItem: jest.fn(async (key) => values.get(key) ?? null),
        setItem: jest.fn(async (key, value) => values.set(key, value)),
      },
      sync,
      now: () => 1_000_000,
    });

    await expect(coordinator.run('user-1')).rejects.toThrow('offline');
    await expect(coordinator.run('user-1')).resolves.toBe(true);
    expect(sync).toHaveBeenCalledTimes(2);
  });
});
