import { BadRequestException, NotFoundException } from '@nestjs/common';
import { AnnouncementService, resolveAction } from './announcement.service';

function model(fns: string[]) {
  const m: Record<string, jest.Mock> = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  return {
    announcement: model([
      'findFirst',
      'findMany',
      'findUnique',
      'create',
      'update',
      'updateMany',
      'delete',
    ]),
    $transaction: jest.fn((args: any) => (Array.isArray(args) ? Promise.all(args) : args)),
  } as any;
}

describe('AnnouncementService', () => {
  let prisma: any;
  let broadcast: any;
  let service: AnnouncementService;

  beforeEach(() => {
    prisma = mockPrisma();
    broadcast = { sendFromAnnouncement: jest.fn().mockResolvedValue('b1') };
    service = new AnnouncementService(prisma, broadcast);
  });

  describe('create validation', () => {
    it('requires title.en', async () => {
      await expect(
        service.create('admin', { title: { fr: 'x' }, message: { en: 'm' } } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires message.en', async () => {
      await expect(
        service.create('admin', { title: { en: 't' }, message: {} } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects unsupported locale keys', async () => {
      await expect(
        service.create('admin', { title: { en: 't', xx: 'y' }, message: { en: 'm' } } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts valid en-only input and defaults icon + action', async () => {
      prisma.announcement.create.mockResolvedValue({
        id: 'a1',
        title: { en: 't' },
        message: { en: 'm' },
      });
      await service.create('admin', { title: { en: 't' }, message: { en: 'm' } } as any);
      const data = prisma.announcement.create.mock.calls[0][0].data;
      expect(data.icon).toBe('information-circle-outline');
      expect(data.actionTarget).toBe('none');
      expect(data.active).toBe(false);
    });

    it('normalizes an unknown icon to the default', async () => {
      prisma.announcement.create.mockResolvedValue({ id: 'a1' });
      await service.create('admin', {
        icon: 'evil-icon',
        title: { en: 't' },
        message: { en: 'm' },
      } as any);
      expect(prisma.announcement.create.mock.calls[0][0].data.icon).toBe(
        'information-circle-outline',
      );
    });
  });

  describe('action validation', () => {
    it('rejects a navigate target not on the whitelist', async () => {
      await expect(
        service.create('admin', {
          title: { en: 't' },
          message: { en: 'm' },
          actionTarget: 'bogus',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires showId for the show target', async () => {
      await expect(
        service.create('admin', {
          title: { en: 't' },
          message: { en: 'm' },
          actionTarget: 'show',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires listId for the list target', async () => {
      await expect(
        service.create('admin', {
          title: { en: 't' },
          message: { en: 'm' },
          actionTarget: 'list',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('requires url for the external target', async () => {
      await expect(
        service.create('admin', {
          title: { en: 't' },
          message: { en: 'm' },
          actionTarget: 'external',
        } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a valid navigate target with params', async () => {
      prisma.announcement.create.mockResolvedValue({
        id: 'a1',
        actionTarget: 'show',
        actionParams: { showId: 's1' },
      });
      await service.create('admin', {
        title: { en: 't' },
        message: { en: 'm' },
        actionTarget: 'show',
        actionParams: { showId: 's1' },
      } as any);
      expect(prisma.announcement.create).toHaveBeenCalled();
    });
  });

  describe('activate', () => {
    it('deactivates others and sets active, fires one-shot push', async () => {
      prisma.announcement.findUnique.mockResolvedValue({
        id: 'a1',
        pushSentAt: null,
        title: { en: 't' },
        message: { en: 'm' },
      });
      prisma.announcement.update.mockResolvedValue({ id: 'a1', revision: 1, active: true });
      const res = await service.activate('admin', 'a1', { alsoPush: true });
      expect(prisma.$transaction).toHaveBeenCalled();
      expect(broadcast.sendFromAnnouncement).toHaveBeenCalled();
      expect(prisma.announcement.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1' }, data: { pushSentAt: expect.any(Date) } }),
      );
      expect(res.pushed).toBe(true);
    });

    it('does not re-push when already pushed', async () => {
      prisma.announcement.findUnique.mockResolvedValue({ id: 'a1', pushSentAt: new Date() });
      prisma.announcement.update.mockResolvedValue({ id: 'a1', revision: 1, active: true });
      const res = await service.activate('admin', 'a1', { alsoPush: true });
      expect(broadcast.sendFromAnnouncement).not.toHaveBeenCalled();
      expect(res.pushed).toBe(false);
    });
  });

  describe('bumpRevision', () => {
    it('increments the revision', async () => {
      prisma.announcement.findUnique.mockResolvedValue({ id: 'a1' });
      prisma.announcement.update.mockResolvedValue({ id: 'a1', revision: 5 });
      const res = await service.bumpRevision('admin', 'a1');
      expect(prisma.announcement.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { revision: { increment: 1 } } }),
      );
      expect(res.revision).toBe(5);
    });
  });

  describe('resolveAction', () => {
    it('none when target missing', () => {
      expect(resolveAction(null, null).type).toBe('none');
    });
    it('external with url', () => {
      expect(resolveAction('external', { url: 'https://x' })).toEqual({
        type: 'external',
        target: 'external',
        params: { url: 'https://x' },
      });
    });
    it('navigate preserves params', () => {
      expect(resolveAction('show', { showId: 's1' })).toEqual({
        type: 'navigate',
        target: 'show',
        params: { showId: 's1' },
      });
    });
  });

  describe('getActive', () => {
    it('returns null when none active', async () => {
      prisma.announcement.findFirst.mockResolvedValue(null);
      expect(await service.getActive()).toBeNull();
    });
  });

  describe('remove', () => {
    it('throws when not found', async () => {
      prisma.announcement.findUnique.mockResolvedValue(null);
      await expect(service.remove('admin', 'x')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
