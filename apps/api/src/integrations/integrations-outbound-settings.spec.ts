import { BadRequestException } from '@nestjs/common';
import { IntegrationsService } from './integrations.service';

function setup() {
  const row = {
    id: 'integration-1',
    userId: 'user-1',
    provider: 'SIMKL',
    connectedAt: new Date('2026-09-01T00:00:00Z'),
    syncSettings: null,
    outboundEnabled: false,
    _count: { syncedItems: 0, simklSyncItems: 0 },
  };
  const prisma: any = {
    userIntegration: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => ({ ...row, ...data })),
    },
  };
  const outbound = { bootstrap: jest.fn(async () => undefined) };
  const service = new IntegrationsService(
    prisma,
    {} as any,
    {} as any,
    {} as any,
    { available: true } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    outbound as any,
  );
  return { prisma, outbound, service };
}

describe('IntegrationsService SIMKL sync-back settings', () => {
  it('enables the default-off outbound bootstrap only for SIMKL', async () => {
    const { prisma, outbound, service } = setup();

    const result = await service.updateSettings('user-1', 'SIMKL', {
      syncBackEnabled: true,
    });

    expect(prisma.userIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          outboundEnabled: true,
          outboundStatus: 'SYNCING',
          outboundBootstrapAt: null,
        }),
      }),
    );
    expect(outbound.bootstrap).toHaveBeenCalledWith('user-1');
    expect(result.syncBack).toMatchObject({
      supported: true,
      enabled: true,
      status: 'SYNCING',
    });
  });

  it('rejects the SIMKL-only setting on other providers', async () => {
    const { service } = setup();
    await expect(
      service.updateSettings('user-1', 'PLEX', { syncBackEnabled: true }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('IntegrationsService SIMKL relink recovery', () => {
  it('replaces credentials encrypted with an old key instead of returning 500', async () => {
    const prisma: any = {
      userIntegration: {
        findUnique: jest.fn(async () => ({
          id: 'integration-1',
          credentialsEncrypted: 'unreadable',
          connectedAt: new Date(),
        })),
        upsert: jest.fn(async () => ({})),
      },
    };
    const secrets = {
      decrypt: jest.fn(() => {
        throw new Error('old encryption key');
      }),
      encrypt: jest.fn(() => 'fresh-encrypted-pending'),
    };
    const simkl = {
      available: true,
      startLink: jest.fn(async () => ({
        code: 'ABCDE',
        verificationUrl: 'https://simkl.com/pin',
        expiresAt: new Date('2026-09-02T20:00:00Z'),
        pollAfterSeconds: 5,
      })),
    };
    const service = new IntegrationsService(
      prisma,
      {} as any,
      secrets as any,
      {} as any,
      simkl as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(service.startLink('user-1', 'SIMKL')).resolves.toMatchObject({
      provider: 'SIMKL',
      code: 'ABCDE',
    });
    expect(prisma.userIntegration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          credentialsEncrypted: 'fresh-encrypted-pending',
          connectedAt: null,
          paused: true,
          outboundStatus: 'IDLE',
        }),
      }),
    );
  });
});
