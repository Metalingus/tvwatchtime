import {
  LB_COMPUTED_VERSION_KEY,
  LB_VERSION_KEY,
  LeaderboardBustProcessor,
} from './leaderboard-bust.processor';

describe('LeaderboardBustProcessor', () => {
  function make(version = '1', computedVersion = '0') {
    const redis = {
      client: {
        incr: jest.fn(async () => Number(version)),
        set: jest.fn(async () => 'OK'),
        get: jest.fn(async (key: string) =>
          key === LB_VERSION_KEY
            ? version
            : key === LB_COMPUTED_VERSION_KEY
              ? computedVersion
              : null,
        ),
      },
      del: jest.fn(async () => undefined),
    };
    return { redis, processor: new LeaderboardBustProcessor(redis as any) };
  }

  it('increments the generation for every watch mutation before deleting caches', async () => {
    const { processor, redis } = make();

    await processor.request();

    expect(redis.client.incr).toHaveBeenCalledWith(LB_VERSION_KEY);
    expect(redis.del).toHaveBeenCalledTimes(3);
  });

  it('keeps a rebuilt cache when the trailing bust generation is already current', async () => {
    const { processor, redis } = make('2', '2');

    await (processor as any).bust();

    expect(redis.del).not.toHaveBeenCalled();
  });
});
