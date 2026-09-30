import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { ProviderRateLimiter } from './rate-limiter';

const url = process.env.WATCHFORGE_TEST_REDIS_URL;
const suite = url ? describe : describe.skip;
suite('Provider quotas — actual Redis scripts', () => {
  let client: Redis;
  const keys = new Set<string>();
  beforeAll(() => {
    let target: URL;
    try {
      target = new URL(url!);
    } catch {
      throw new Error('Invalid local Redis test target');
    }
    if (!['localhost', '127.0.0.1'].includes(target.hostname))
      throw new Error('Local Redis required');
    client = new Redis(url!, { maxRetriesPerRequest: 0 });
  });
  afterEach(async () => {
    if (keys.size) await client.del(...keys);
    keys.clear();
  });
  afterAll(async () => {
    client?.disconnect();
  });

  it('does not consume minute quota while polling a blocked second', async () => {
    const provider = 'identity-limit-test-' + randomUUID(),
      base = Math.floor(Date.now() / 60000) * 60000 + 100;
    const limiter = new ProviderRateLimiter({ client } as any);
    let now = base;
    (limiter as any).nowMs = () => now;
    for (let second = 0; second < 3; second++)
      keys.add('RL:' + provider + ':s:' + Math.floor((base + second * 1000) / 1000));
    const minute = 'RL:' + provider + ':m:' + Math.floor(base / 60000);
    keys.add(minute);
    const cfg = { enabled: true, rps: 1, rpm: 2, concurrency: 1 };
    expect((await limiter.fixedWindow(provider, cfg)).allowed).toBe(true);
    for (let i = 0; i < 20; i++)
      expect((await limiter.fixedWindow(provider, cfg)).allowed).toBe(false);
    now += 1000;
    expect((await limiter.fixedWindow(provider, cfg)).allowed).toBe(true);
    now += 1000;
    expect(await limiter.fixedWindow(provider, cfg)).toEqual({
      allowed: false,
      retryAfterMs: 57900,
    });
    expect(await client.get(minute)).toBe('2');
  });

  it('enforces the rolling daily cap atomically across concurrent callers', async () => {
    const provider = 'identity-daily-test-' + randomUUID(),
      limiter = new ProviderRateLimiter({ client } as any);
    keys.add('RL:' + provider + ':daily');
    const results = await Promise.all(
      Array.from({ length: 30 }, () => limiter.dailyBudget(provider, 7)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect(await client.zcard('RL:' + provider + ':daily')).toBe(7);
    expect(await client.pttl('RL:' + provider + ':daily')).toBeGreaterThan(0);
  });
});
