const storage = {
  getRefresh: jest.fn(),
  getAccess: jest.fn(),
  getApiUrl: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  setUser: jest.fn().mockResolvedValue(undefined),
  clear: jest.fn().mockResolvedValue(undefined),
};

jest.mock('expo-constants', () => ({
  expoConfig: { extra: { apiBaseUrl: 'https://example.test/api' } },
}));
jest.mock('../storage', () => ({ tokenStorage: storage }));

import { refreshTokens, setSessionExpiredHandler } from '../client';

const response = (status: number, data: unknown) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(data),
  }) as unknown as Response;

describe('mobile refresh handling', () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    jest.clearAllMocks();
    storage.getApiUrl.mockResolvedValue(null);
    setSessionExpiredHandler(null);
  });

  afterAll(() => fetchMock.mockRestore());

  it('clears the session only when the refresh token is definitively rejected', async () => {
    const expired = jest.fn();
    setSessionExpiredHandler(expired);
    storage.getRefresh.mockResolvedValue('refresh-token');
    fetchMock.mockResolvedValue(response(401, { message: 'Invalid refresh token' }));

    const outcome = await refreshTokens();

    expect(outcome.status).toBe('invalid');
    expect(storage.clear).toHaveBeenCalledTimes(1);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('keeps credentials during a temporary API restart', async () => {
    storage.getRefresh.mockResolvedValue('refresh-token');
    fetchMock.mockResolvedValue(response(503, { message: 'Unavailable' }));

    const outcome = await refreshTokens();

    expect(outcome.status).toBe('transient');
    expect(storage.clear).not.toHaveBeenCalled();
  });

  it('does not leave the single-flight refresh promise stuck after a missing token', async () => {
    storage.getRefresh.mockResolvedValueOnce(null).mockResolvedValueOnce('refresh-token');
    fetchMock.mockResolvedValue(
      response(200, {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        user: { id: 'user' },
      }),
    );

    await expect(refreshTokens()).resolves.toEqual({ status: 'missing' });
    await expect(refreshTokens()).resolves.toEqual({ status: 'refreshed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storage.set).toHaveBeenCalledWith('new-access', 'new-refresh');
  });
});
