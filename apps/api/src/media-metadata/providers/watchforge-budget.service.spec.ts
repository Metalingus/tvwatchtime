import { Logger } from '@nestjs/common';
import {
  admitWatchForgeLane,
  type LaneNumbers,
  WatchForgeBudget,
  type WatchForgeBudgetConfig,
} from './watchforge-budget.service';

const shares: LaneNumbers = { interactive: 0.45, repair: 0.25, backlog: 0.3 };
const used = (interactive: number, repair: number, backlog: number) => ({
  interactive,
  repair,
  backlog,
});
const admit = (
  lane: 'interactive' | 'repair' | 'backlog',
  usage: LaneNumbers,
  extra: Partial<Parameters<typeof admitWatchForgeLane>[0]> = {},
) =>
  admitWatchForgeLane({ lane, limit: 1000, used: usage, shares, backlogReleased: false, ...extra });

describe('admitWatchForgeLane', () => {
  it('lets interactive use any capacity left in the day, including other lanes floors', () => {
    expect(admit('interactive', used(900, 0, 0))).toBe(true);
    expect(admit('interactive', used(999, 0, 0))).toBe(true);
    expect(admit('interactive', used(1000, 0, 0))).toBe(false);
  });

  it('never lets repair spend capacity still reserved for interactive', () => {
    // interactive floor 450 unused; repair past its 250 floor may only borrow unreserved capacity
    expect(admit('repair', used(0, 549, 0))).toBe(true);
    expect(admit('repair', used(0, 550, 0))).toBe(false);
    expect(admit('repair', used(450, 549, 0))).toBe(true);
  });

  it('keeps backlog within its floor until the late-day release', () => {
    expect(admit('backlog', used(0, 0, 299))).toBe(true);
    expect(admit('backlog', used(0, 0, 300))).toBe(false);
    expect(admit('backlog', used(0, 0, 300), { backlogReleased: true })).toBe(true);
  });

  it('after release, backlog takes unused reservations except a late interactive reserve', () => {
    // interactive floor 450 unused → only 10% (100) stays protected late in the day
    expect(admit('backlog', used(0, 0, 899), { backlogReleased: true })).toBe(true);
    expect(admit('backlog', used(0, 0, 900), { backlogReleased: true })).toBe(false);
    // interactive already used its floor → nothing left to protect
    expect(admit('backlog', used(450, 0, 549), { backlogReleased: true })).toBe(true);
    // interactive can still use the protected reserve
    expect(admit('interactive', used(0, 0, 900), { backlogReleased: true })).toBe(true);
  });

  it('trusts the provider count when it shows more usage than ours', () => {
    expect(admit('interactive', used(10, 0, 0), { providerUsed: 1000 })).toBe(false);
    expect(admit('backlog', used(0, 0, 10), { providerUsed: 720 })).toBe(false);
  });
});

function fixture() {
  const cache = new Map<string, unknown>();
  const hashes = new Map<string, Record<string, string>>();
  const redis: any = {
    get: jest.fn(async (key: string) => cache.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown) => void cache.set(key, value)),
    client: {
      hgetall: jest.fn(async (key: string) => ({ ...(hashes.get(key) ?? {}) })),
      hset: jest.fn(async (key: string, ...pairs: string[]) => {
        const hash = hashes.get(key) ?? {};
        for (let i = 0; i < pairs.length; i += 2) hash[pairs[i]] = pairs[i + 1];
        hashes.set(key, hash);
      }),
      hincrby: jest.fn(async (key: string, field: string, by: number) => {
        const hash = hashes.get(key) ?? {};
        hash[field] = String(Number(hash[field] ?? 0) + by);
        hashes.set(key, hash);
      }),
      expire: jest.fn(async () => 1),
    },
  };
  const rows: Array<{ lane: string; requests: number }> = [];
  const prisma: any = {
    watchForgeUsageDay: {
      findMany: jest.fn(async () => rows),
      upsert: jest.fn(async () => undefined),
    },
  };
  const cfg: WatchForgeBudgetConfig = {
    requestsPerDayCap: null,
    fallbackRequestsPerDay: 900,
    lanes: shares,
    backlogReleaseHourUtc: 21,
  };
  return { budget: new WatchForgeBudget(prisma, redis), redis, prisma, rows, cfg, hashes, cache };
}

const at = (iso: string) => Date.parse(iso);

describe('WatchForgeBudget', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('re-seeds today from the database after a Redis flush, so the quota cannot reset', async () => {
    const f = fixture();
    f.rows.push({ lane: 'repair', requests: 240 });
    expect(await f.budget.used('cred', at('2026-09-30T10:00:00Z'))).toEqual(used(0, 240, 0));
    expect(f.hashes.get('WF:cred:spend:2026-09-30')).toEqual({ repair: '240' });
  });

  it('uses the account limit with a safety margin and honors an explicit lower cap', async () => {
    const f = fixture();
    expect(await f.budget.limit('cred', f.cfg)).toEqual({ limit: 900, source: 'fallback' });
    await f.budget.setAccountLimit('cred', 5000, 60);
    expect(await f.budget.limit('cred', f.cfg)).toEqual({ limit: 4900, source: 'provider' });
    expect(await f.budget.limit('cred', { ...f.cfg, requestsPerDayCap: 1200 })).toEqual({
      limit: 1200,
      source: 'provider',
    });
  });

  it('records admitted spend in Redis and the durable mirror', async () => {
    const f = fixture();
    expect(await f.budget.admit('cred', 'backlog', f.cfg, at('2026-09-30T10:00:00Z'))).toEqual({
      allowed: true,
      retryAfterMs: 0,
    });
    expect(f.hashes.get('WF:cred:spend:2026-09-30')).toEqual({ backlog: '1' });
    expect(f.prisma.watchForgeUsageDay.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { requests: { increment: 1 } } }),
    );
  });

  it('asks a floor-exhausted backlog to come back at the release hour, not midnight', async () => {
    const f = fixture();
    f.hashes.set('WF:cred:spend:2026-09-30', { backlog: '270' }); // floor = 900 × 0.3
    const denied = await f.budget.admit('cred', 'backlog', f.cfg, at('2026-09-30T10:00:00Z'));
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBe(11 * 3_600_000);
  });

  it('asks an exhausted day to come back after the UTC reset', async () => {
    const f = fixture();
    f.hashes.set('WF:cred:spend:2026-09-30', { interactive: '900' });
    const denied = await f.budget.admit('cred', 'interactive', f.cfg, at('2026-09-30T22:00:00Z'));
    expect(denied).toEqual({ allowed: false, retryAfterMs: 2 * 3_600_000 });
  });

  it('only treats the daily X-RateLimit window as quota evidence', async () => {
    const f = fixture();
    await f.budget.setAccountLimit('cred', 1000, 60);
    const now = at('2026-09-30T10:00:00Z');
    const headers = (limit: string) =>
      new Headers({
        'X-RateLimit-Limit': limit,
        'X-RateLimit-Remaining': '5',
        'X-RateLimit-Reset': String(now / 1000 + 600),
      });
    await f.budget.observeHeaders('cred', headers('60'), now);
    expect(f.cache.has('WF:cred:window')).toBe(false);
    await f.budget.observeHeaders('cred', headers('1000'), now);
    expect(f.cache.get('WF:cred:window')).toMatchObject({ limit: 1000, remaining: 5 });
    // 995 used by the provider's own count: backlog is out even though we counted nothing
    expect((await f.budget.admit('cred', 'backlog', f.cfg, now)).allowed).toBe(false);
  });
});
