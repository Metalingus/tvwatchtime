import { ConversationsController } from './conversations.controller';

function fixture(kind = 'star_rating', value: string | null = '4') {
  const target = {
    threadType: 'EPISODE',
    threadId: 'canonical-episode',
    mediaId: 'canonical-show',
    entityId: 'entity',
    entityType: 'episode',
    fingerprint: 'verified',
  };
  const reads: any = {
    engagement: jest.fn().mockResolvedValue({
      writesEnabled: true,
      sections: [{ kind, options: [{ key: 'option', localValue: value }] }],
    }),
  };
  const client: any = { assertWrites: jest.fn() };
  const publication: any = {
    enqueue: jest.fn().mockResolvedValue({ id: 'operation', state: 'PENDING' }),
  };
  const resolver: any = {
    resolve: jest.fn().mockResolvedValue(target),
    path: () => '/entities/episode/entity',
  };
  const controller = new ConversationsController(
    {} as any,
    reads,
    resolver,
    client,
    publication,
    {} as any,
    {} as any,
    {} as any,
  );
  return { controller, client, publication, resolver, reads, target };
}

it('keeps generic star selections on the same local vote and receipt path as native controls', async () => {
  const f = fixture();
  await f.controller.vote(
    'user',
    { threadType: 'EPISODE', threadId: 'alias' } as any,
    { kind: 'star_rating', optionKey: 'option', selected: true, actionId: 'id' } as any,
  );
  const args = f.publication.enqueue.mock.calls[0];
  expect(args[3]).toEqual({ intent: { kind: 'star_rating', value: '4', selected: true } });
  const tx: any = {
    userEpisodeStatus: { findUnique: jest.fn().mockResolvedValue({ watched: true }) },
    rating: { upsert: jest.fn() },
  };
  await args[7](tx);
  expect(tx.rating.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      create: { userId: 'user', episodeId: 'canonical-episode', rating: 4, source: 'MANUAL' },
      update: { rating: 4, source: 'MANUAL', sourceKey: null },
    }),
  );
});
it('rejects an unverified cast mapping rather than creating a provider-only duplicate vote', async () => {
  const f = fixture('cast_vote', null);
  await expect(
    f.controller.vote(
      'user',
      { threadType: 'EPISODE', threadId: 'episode' } as any,
      { kind: 'cast_vote', optionKey: 'option', selected: true, actionId: 'id' } as any,
    ),
  ).rejects.toThrow('Unmapped');
  expect(f.publication.enqueue).not.toHaveBeenCalled();
});
it('rechecks title ownership before saving a mapped character vote', async () => {
  const f = fixture('cast_vote', 'credit');
  await f.controller.vote(
    'user',
    { threadType: 'EPISODE', threadId: 'episode' } as any,
    { kind: 'cast_vote', optionKey: 'option', selected: true, actionId: 'id' } as any,
  );
  const mutate = f.publication.enqueue.mock.calls[0][7];
  const tx: any = {
    userEpisodeStatus: { findUnique: jest.fn().mockResolvedValue({ watched: true }) },
    mediaCast: { findFirst: jest.fn().mockResolvedValue(null) },
    characterVote: { upsert: jest.fn() },
  };
  await expect(mutate(tx)).rejects.toThrow('Character is not part of this title');
  expect(tx.characterVote.upsert).not.toHaveBeenCalled();
});
it('honors the global write gate before reading or changing any vote', async () => {
  const f = fixture();
  f.client.assertWrites.mockImplementation(() => {
    throw Error('disabled');
  });
  await expect(f.controller.vote('user', {} as any, {} as any)).rejects.toThrow('disabled');
  expect(f.resolver.resolve).not.toHaveBeenCalled();
  expect(f.publication.enqueue).not.toHaveBeenCalled();
});

it('does not let a deleted traversal placeholder create a block or report', async () => {
  const prisma: any = {
    commsUniAuthorBlock: { upsert: jest.fn() },
    commsUniReport: { upsert: jest.fn() },
  };
  const controller = new ConversationsController(
    {} as any,
    { comment: async () => ({ deleted: true }) } as any,
    { resolve: async () => ({}) } as any,
    {} as any,
    {} as any,
    prisma,
    {} as any,
    {} as any,
  );
  for (const action of ['block', 'report'])
    await expect(
      controller.action(
        'user',
        'comment',
        { threadType: 'MOVIE', threadId: 'movie' } as any,
        { action } as any,
      ),
    ).rejects.toThrow('Comment has been deleted');
  expect(prisma.commsUniAuthorBlock.upsert).not.toHaveBeenCalled();
  expect(prisma.commsUniReport.upsert).not.toHaveBeenCalled();
});
