import { ModerationService } from './moderation.service';
const authorId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const prisma: any = {
    block: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          {
            createdAt: new Date('2026-01-01'),
            blocked: { id: 'native', username: 'alice', profile: null },
          },
        ]),
      deleteMany: jest.fn(),
    },
    commsUniAuthorBlock: {
      findMany: jest.fn().mockResolvedValue([{ authorId, name: 'Remote user' }]),
      deleteMany: jest.fn(),
    },
    commsUniIdentity: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn(async (fn) => fn(prisma)),
  };
  const client: any = { scope: 'scope', request: jest.fn() };
  return { prisma, client, service: new ModerationService(prisma, client) };
}
it('lists both kinds of personal blocks without fabricating local user IDs', async () => {
  const f = fixture();
  const rows = await f.service.getBlockedUsers('viewer');
  expect(rows.map((row) => [row.id, row.kind])).toEqual([
    ['native', 'local'],
    ['commsuni:' + authorId, 'commsuni'],
  ]);
  expect(f.client.request).not.toHaveBeenCalled();
});
it('does not list the same explicitly linked user twice', async () => {
  const f = fixture();
  f.prisma.commsUniIdentity.findMany.mockResolvedValue([{ authorId }]);
  expect(await f.service.getBlockedUsers('viewer')).toHaveLength(1);
});
it('unblocks the requesting user’s stored provider block and its explicit local counterpart only', async () => {
  const f = fixture();
  f.prisma.commsUniIdentity.findMany.mockResolvedValue([{ authorId, userId: 'native' }]);
  await f.service.unblock('viewer', 'commsuni:' + authorId);
  expect(f.prisma.block.deleteMany).toHaveBeenCalledWith({
    where: { blockerId: 'viewer', blockedId: { in: ['native'] } },
  });
  expect(f.prisma.commsUniAuthorBlock.deleteMany).toHaveBeenCalledWith({
    where: { userId: 'viewer', scope: 'scope', authorId: { in: [authorId] } },
  });
  expect(f.client.request).not.toHaveBeenCalled();
});
it('rejects a malformed provider identity before touching stored blocks', async () => {
  const f = fixture();
  await expect(f.service.unblock('viewer', 'commsuni:')).rejects.toThrow('Invalid blocked user');
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
});
