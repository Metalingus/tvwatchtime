import { NotificationCategory, NotificationTiming } from '@prisma/client';
import { NotificationService } from './notification.service';

function preferenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pref-1',
    userId: 'user-1',
    preferences: {},
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    timezone: null,
    timing: NotificationTiming.AT_RELEASE,
    createdAt: new Date('2026-08-03T00:00:00.000Z'),
    updatedAt: new Date('2026-08-03T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationService preferences', () => {
  let prisma: any;
  let service: NotificationService;

  beforeEach(() => {
    prisma = {
      notificationPreference: {
        upsert: jest.fn(),
      },
    };
    service = new NotificationService(prisma, {} as any, {} as any, {} as any);
  });

  it('atomically creates default preferences on first access', async () => {
    prisma.notificationPreference.upsert.mockImplementation(async ({ create }: any) =>
      preferenceRow({ userId: create.userId, preferences: create.preferences }),
    );

    const result = await service.getPreferences('user-1');

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      create: {
        userId: 'user-1',
        preferences: expect.any(Object),
      },
      update: {},
    });
    expect(Object.keys(result.preferences).sort()).toEqual(
      Object.values(NotificationCategory).sort(),
    );
    expect(
      Object.values(result.preferences).every((preference) =>
        Boolean(preference.push && preference.inApp),
      ),
    ).toBe(true);
  });

  it('returns existing custom preferences without overwriting them', async () => {
    const custom = {
      [NotificationCategory.BADGE]: { push: false, inApp: true },
    };
    prisma.notificationPreference.upsert.mockResolvedValue(
      preferenceRow({
        preferences: custom,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        timezone: 'America/Toronto',
      }),
    );

    const result = await service.getPreferences('user-1');

    expect(prisma.notificationPreference.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: {} }),
    );
    expect(result).toEqual({
      preferences: custom,
      quietHoursEnabled: true,
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'America/Toronto',
      timing: NotificationTiming.AT_RELEASE,
    });
  });

  it('allows concurrent first-access callers to use the same atomic path', async () => {
    prisma.notificationPreference.upsert.mockImplementation(async ({ create }: any) =>
      preferenceRow({ userId: create.userId, preferences: create.preferences }),
    );

    await expect(
      Promise.all([service.getPreferences('user-1'), service.getPreferences('user-1')]),
    ).resolves.toHaveLength(2);
    expect(prisma.notificationPreference.upsert).toHaveBeenCalledTimes(2);
  });
});

describe('NotificationService push gating', () => {
  it('does not schedule a push when the global push feature is disabled', async () => {
    const prisma: any = {
      notificationPreference: {
        upsert: jest.fn(async () =>
          preferenceRow({
            preferences: {
              [NotificationCategory.SYSTEM]: { push: true, inApp: true },
            },
          }),
        ),
      },
      notification: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async () => ({})),
      },
      pushNotificationJob: { count: jest.fn(async () => 0) },
    };
    const push = { schedule: jest.fn() };
    const config = { get: jest.fn(() => 3) };
    const flags = { isEnabled: jest.fn(async () => false) };
    const service = new NotificationService(prisma, push as any, config as any, flags as any);

    await service.createForUser('user-1', {
      category: NotificationCategory.SYSTEM,
      title: 'Your import is ready',
      dedupeKey: 'import-ready:import-1',
      push: true,
    });

    expect(prisma.notification.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ channel: 'IN_APP' }) }),
    );
    expect(push.schedule).not.toHaveBeenCalled();
  });
});
