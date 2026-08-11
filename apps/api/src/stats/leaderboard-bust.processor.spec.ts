import {
  LB_DIRTY_USERS_KEY,
  LB_VERSION_KEY,
  LeaderboardBustProcessor,
  leaderboardUserVersionKey,
} from './leaderboard-bust.processor';

describe('LeaderboardBustProcessor', () => {
  function make(getJob: jest.Mock = jest.fn(async () => null)) {
    const multi = {
      incr: jest.fn().mockReturnThis(),
      sadd: jest.fn().mockReturnThis(),
      exec: jest.fn(async () => []),
    };
    const redis = { client: { multi: jest.fn(() => multi) } };
    const queue = {
      getJob,
      add: jest.fn(async () => undefined),
    };
    const events = { emitAsync: jest.fn(async () => []) };
    const processor = new LeaderboardBustProcessor(redis as any, events as any);
    (processor as any).queue = queue;
    return { processor, redis, multi, queue };
  }

  it('marks only the changed user dirty and queues one scoped refresh', async () => {
    const { processor, multi, queue } = make();

    await processor.request('user-1');

    expect(multi.incr.mock.calls).toEqual([
      [LB_VERSION_KEY],
      [leaderboardUserVersionKey('user-1')],
    ]);
    expect(multi.sadd).toHaveBeenCalledWith(LB_DIRTY_USERS_KEY, 'user-1');
    expect(queue.add).toHaveBeenCalledWith(
      'refresh-user',
      { userId: 'user-1' },
      expect.objectContaining({ jobId: 'lb-user-refresh-user-1' }),
    );
  });

  it('moves an existing delayed user refresh instead of adding another job', async () => {
    const delayed = {
      getState: jest.fn(async () => 'delayed'),
      changeDelay: jest.fn(async () => undefined),
    };
    const { processor, queue } = make(jest.fn(async () => delayed));

    await processor.request('user-1');

    expect(delayed.changeDelay).toHaveBeenCalledWith((processor as any).delayMs);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retains one trailing refresh when a mutation lands during active work', async () => {
    const active = { getState: jest.fn(async () => 'active') };
    const getJob = jest.fn(async (jobId: string) => (jobId.endsWith('-trailing') ? null : active));
    const { processor, queue } = make(getJob);

    await processor.request('user-1');

    expect(queue.add).toHaveBeenCalledWith(
      'refresh-user',
      { userId: 'user-1' },
      expect.objectContaining({ jobId: 'lb-user-refresh-user-1-trailing' }),
    );
  });
});
