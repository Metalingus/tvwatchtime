import { markPersonalizationDirty, personalizationVersionKey } from './personalization-cache';

describe('personalization cache generation', () => {
  it('increments one user generation without scanning or deleting Redis keys', async () => {
    const redis = {
      client: { incr: jest.fn().mockResolvedValue(4) },
      delByPattern: jest.fn(),
    };

    await markPersonalizationDirty(redis as any, 'user-1');

    expect(redis.client.incr).toHaveBeenCalledWith(personalizationVersionKey('user-1'));
    expect(redis.delByPattern).not.toHaveBeenCalled();
  });
});
