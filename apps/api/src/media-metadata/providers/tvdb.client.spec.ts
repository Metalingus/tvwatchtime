import { TvdbClient } from './tvdb.client';

describe('TvdbClient', () => {
  it('omits the ProviderHttp cache key for an explicit provider refresh', async () => {
    const config = { get: jest.fn().mockReturnValue('tvdb-key') };
    const providerConfig = { tvdb: jest.fn().mockResolvedValue({}) };
    const http = { fetchJson: jest.fn().mockResolvedValue({ data: { id: 77 } }) };
    const redis = {
      get: jest.fn().mockResolvedValue({ token: 'token', exp: Date.now() + 120_000 }),
    };
    const client = new TvdbClient(
      config as any,
      providerConfig as any,
      http as any,
      redis as any,
      {} as any,
    );

    await client.get('/series/77/extended', {}, 'eng', { bypassCache: true });

    expect(http.fetchJson).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'tvdb',
        cacheKey: undefined,
      }),
    );
  });
});
