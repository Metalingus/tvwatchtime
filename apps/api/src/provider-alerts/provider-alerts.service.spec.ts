jest.mock('../media-metadata/util/identity-write-fence', () => ({
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
}));
import { ProviderAlertsService } from './provider-alerts.service';

const blob = {
  US: {
    link: 'https://tmdb/watch',
    stream: [
      { id: 8, name: 'Netflix' },
      { id: 1899, name: 'Max' },
    ],
    rent: [{ id: 2, name: 'Apple TV' }],
    buy: [],
  },
};

function makeService(alerts: any[]) {
  const prisma: any = {
    watchProviderAlert: {
      findMany: jest.fn().mockResolvedValue(alerts),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({}),
    },
    watchProviderCatalog: { findMany: jest.fn().mockResolvedValue([]) },
    mediaItem: {
      findUnique: jest.fn().mockResolvedValue({ id: 'm1' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    device: { findMany: jest.fn().mockResolvedValue([]) },
    notificationPreference: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.$transaction = jest.fn(async (work: any) => work(prisma));
  const notifications = { createForUser: jest.fn().mockResolvedValue({ ok: true }) };
  const meta = {};
  const tmdb = { enabled: false };
  const svc = new ProviderAlertsService(
    prisma as any,
    notifications as any,
    meta as any,
    tmdb as any,
  );
  return { svc, prisma, notifications };
}

function alertRow(overrides: Partial<any> = {}) {
  return {
    id: 'a1',
    userId: 'u1',
    mediaId: 'm1',
    offerType: 'STREAM',
    country: 'US',
    providerIds: [],
    active: true,
    media: {
      id: 'm1',
      type: 'SHOW',
      title: 'House of the Dragon',
      posterUrl: 'https://img/p.jpg',
      watchProviders: blob,
      metadataRefreshedAt: new Date(),
      externalIds: [],
    },
    ...overrides,
  };
}

describe('ProviderAlertsService.checkAlerts', () => {
  it('notifies and disables when a subscribed provider appears (any-provider alert)', async () => {
    const { svc, prisma, notifications } = makeService([alertRow()]);
    const result = await svc.checkAlerts();

    expect(result).toMatchObject({ checked: 1, matched: 1, notified: 1 });
    expect(notifications.createForUser).toHaveBeenCalledTimes(1);
    const [, input] = notifications.createForUser.mock.calls[0];
    expect(input.category).toBe('PROVIDER_ALERT');
    expect(input.link).toBe('tvwatchtime://show/m1');
    expect(input.dedupeKey).toBe('provider-alert:a1');
    expect(input.push).toBe(true);
    expect(input.pushAt.getTime()).toBeGreaterThan(Date.now());
    expect(prisma.watchProviderAlert.update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: { active: false, notifiedAt: expect.any(Date) },
    });
  });

  it('matches only the subscribed provider ids', async () => {
    const { svc, notifications } = makeService([alertRow({ providerIds: [1899] })]);
    const result = await svc.checkAlerts();
    expect(result.matched).toBe(1);
    expect(notifications.createForUser.mock.calls[0][1].body).toContain('Max');
  });

  it('does not notify when subscribed providers are absent', async () => {
    const { svc, prisma, notifications } = makeService([alertRow({ providerIds: [119] })]);
    const result = await svc.checkAlerts();
    expect(result).toMatchObject({ checked: 1, matched: 0, notified: 0 });
    expect(notifications.createForUser).not.toHaveBeenCalled();
    expect(prisma.watchProviderAlert.update).not.toHaveBeenCalled();
  });

  it('scopes matching to the alert offer type and country', async () => {
    const { svc, notifications } = makeService([
      alertRow({ offerType: 'BUY' }), // US buy is empty in the blob
    ]);
    const result = await svc.checkAlerts();
    expect(result.matched).toBe(0);
    expect(notifications.createForUser).not.toHaveBeenCalled();
  });

  it('matches rent offers for rent alerts', async () => {
    const { svc, notifications } = makeService([alertRow({ offerType: 'RENT' })]);
    const result = await svc.checkAlerts();
    expect(result.matched).toBe(1);
    expect(notifications.createForUser.mock.calls[0][1].title).toContain('rent');
  });
});

describe('ProviderAlertsService.upsertAlert', () => {
  it('re-arms a previous alert (active + notifiedAt reset)', async () => {
    const { svc, prisma } = makeService([]);
    await svc.upsertAlert('u1', 'm1', 'STREAM', [8]);
    expect(prisma.watchProviderAlert.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ active: true, notifiedAt: null }),
      }),
    );
  });
});
