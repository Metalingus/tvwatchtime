import {
  recordProviderUsage,
  runWithProviderUsage,
  type ProviderUsage,
} from './provider-usage.context';

describe('provider usage context', () => {
  it('attributes calls to the operation that made them, including concurrent async work', async () => {
    const a: ProviderUsage = {};
    const b: ProviderUsage = {};
    await Promise.all([
      runWithProviderUsage(a, async () => {
        recordProviderUsage('tmdb', 'requests');
        await new Promise((r) => setTimeout(r, 5));
        recordProviderUsage('tmdb', 'cacheHits');
      }),
      runWithProviderUsage(b, async () => {
        await new Promise((r) => setTimeout(r, 1));
        recordProviderUsage('tvdb', 'requests');
      }),
    ]);
    expect(a).toEqual({ tmdb: { requests: 1, cacheHits: 1 } });
    expect(b).toEqual({ tvdb: { requests: 1, cacheHits: 0 } });
  });

  it('is a no-op outside an operation', () => {
    expect(() => recordProviderUsage('tmdb', 'requests')).not.toThrow();
  });
});
