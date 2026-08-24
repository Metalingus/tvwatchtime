import {
  ACCESS_REFRESH_LEEWAY_MS,
  accessTokenNeedsRefresh,
  isTerminalRefreshStatus,
  jwtExpiresAt,
} from '../auth-token';

const token = (expiresAtMs: number) => {
  const payload = Buffer.from(JSON.stringify({ sub: 'user', exp: expiresAtMs / 1000 })).toString(
    'base64url',
  );
  return `header.${payload}.signature`;
};

describe('mobile auth token freshness', () => {
  const now = Date.parse('2026-08-24T12:00:00.000Z');

  it('reads expiry and refreshes inside the foreground leeway', () => {
    const fresh = token(now + ACCESS_REFRESH_LEEWAY_MS + 1000);
    const expiring = token(now + ACCESS_REFRESH_LEEWAY_MS);
    expect(jwtExpiresAt(fresh)).toBe(now + ACCESS_REFRESH_LEEWAY_MS + 1000);
    expect(accessTokenNeedsRefresh(fresh, now)).toBe(false);
    expect(accessTokenNeedsRefresh(expiring, now)).toBe(true);
  });

  it('treats missing or malformed access tokens as needing refresh', () => {
    expect(accessTokenNeedsRefresh(null, now)).toBe(true);
    expect(accessTokenNeedsRefresh('not-a-jwt', now)).toBe(true);
  });

  it('distinguishes terminal credential failures from restart/server failures', () => {
    expect([400, 401, 403, 404].every(isTerminalRefreshStatus)).toBe(true);
    expect(isTerminalRefreshStatus(429)).toBe(false);
    expect(isTerminalRefreshStatus(500)).toBe(false);
    expect(isTerminalRefreshStatus(503)).toBe(false);
  });
});
