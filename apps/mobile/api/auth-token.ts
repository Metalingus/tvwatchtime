export const ACCESS_REFRESH_LEEWAY_MS = 5 * 60_000;

/** Read the JWT expiry without trusting or verifying the token client-side. */
export function jwtExpiresAt(token: string | null | undefined): number | null {
  if (!token) return null;
  const payload = token.split('.')[1];
  if (!payload || typeof globalThis.atob !== 'function') return null;
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const decoded = globalThis.atob(padded);
    const match = /"exp"\s*:\s*(\d+)/.exec(decoded);
    return match ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  }
}

export function accessTokenNeedsRefresh(
  token: string | null | undefined,
  now = Date.now(),
  leewayMs = ACCESS_REFRESH_LEEWAY_MS,
): boolean {
  const expiresAt = jwtExpiresAt(token);
  return expiresAt === null || expiresAt <= now + leewayMs;
}

/** Only definite credential/user failures should destroy the local session. */
export function isTerminalRefreshStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403 || status === 404;
}
