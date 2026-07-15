import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ContactService } from './contact.service';

function model(fns: string[]) {
  const m: Record<string, jest.Mock> = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  return {
    contactThread: model(['count', 'create', 'findUnique', 'findMany', 'update', 'updateMany']),
    contactMessage: model(['create']),
    $transaction: jest.fn((args: any) => (Array.isArray(args) ? Promise.all(args) : args)),
  } as any;
}

describe('ContactService', () => {
  let prisma: any;
  let notifications: any;
  let service: ContactService;

  beforeEach(() => {
    prisma = mockPrisma();
    notifications = { createForUser: jest.fn().mockResolvedValue({ ok: true }) };
    service = new ContactService(prisma, notifications);
  });

  describe('create', () => {
    it('rejects when the open-thread cap is reached', async () => {
      prisma.contactThread.count.mockResolvedValue(5);
      await expect(
        service.create('u1', { reason: 'FEEDBACK', subject: 'hi', body: 'hello' } as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.contactThread.create).not.toHaveBeenCalled();
    });

    it('creates a thread with the first user message', async () => {
      prisma.contactThread.count.mockResolvedValue(0);
      prisma.contactThread.create.mockResolvedValue({
        id: 't1',
        reason: 'FEEDBACK',
        subject: 'hi',
        status: 'OPEN',
        adminReplied: false,
        createdAt: new Date(),
        lastMessageAt: new Date(),
        messages: [{ id: 'm1', authorRole: 'USER', body: 'hello', createdAt: new Date() }],
      });
      const res = await service.create('u1', {
        reason: 'FEEDBACK',
        subject: 'hi',
        body: 'hello',
      } as any);
      const data = prisma.contactThread.create.mock.calls[0][0].data;
      expect(data.userId).toBe('u1');
      expect(data.messages.create.authorRole).toBe('USER');
      expect(res.id).toBe('t1');
      expect(res.messages).toHaveLength(1);
    });
  });

  describe('getForUser', () => {
    it('throws when the thread does not belong to the user', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
      await expect(service.getForUser('u1', 't1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('marks the thread read for the user', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        messages: [],
        createdAt: new Date(),
        lastMessageAt: new Date(),
      });
      await service.getForUser('u1', 't1');
      expect(prisma.contactThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 't1' } }),
      );
    });
  });

  describe('replyAsUser', () => {
    it('reopens a closed thread on user reply', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({
        id: 't1',
        userId: 'u1',
        status: 'CLOSED',
      });
      const res = await service.replyAsUser('u1', 't1', { body: 'again' } as any);
      expect(prisma.contactMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ authorRole: 'USER', body: 'again' }),
        }),
      );
      expect(prisma.contactThread.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'OPEN', closedAt: null }),
        }),
      );
      expect(res.reopened).toBe(true);
    });

    it('throws for a non-owner', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({ id: 't1', userId: 'other' });
      await expect(service.replyAsUser('u1', 't1', { body: 'x' } as any)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('replyAsAdmin', () => {
    it('sets adminReplied and notifies the user', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({ id: 't1', userId: 'u1', status: 'OPEN' });
      await service.replyAsAdmin('admin1', 't1', { body: 'answer' } as any);
      expect(prisma.contactMessage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ authorRole: 'ADMIN' }) }),
      );
      expect(prisma.contactThread.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ adminReplied: true }) }),
      );
      expect(notifications.createForUser).toHaveBeenCalledWith(
        'u1',
        expect.objectContaining({ category: 'CONTACT', push: true, link: 'tvwatchtime://contact' }),
      );
    });
  });

  describe('close / reopen', () => {
    it('throws when the thread is missing', async () => {
      prisma.contactThread.findUnique.mockResolvedValue(null);
      await expect(service.close('admin1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('closes and reopens', async () => {
      prisma.contactThread.findUnique.mockResolvedValue({ id: 't1' });
      await service.close('admin1', 't1');
      expect(prisma.contactThread.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'CLOSED' }) }),
      );
      await service.reopen('admin1', 't1');
      expect(prisma.contactThread.update).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'OPEN', closedAt: null }),
        }),
      );
    });
  });
});
