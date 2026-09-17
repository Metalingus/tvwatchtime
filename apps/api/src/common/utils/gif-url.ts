import { isIP } from 'net';

export const GIF_URL_MAX_LENGTH = 2048;

/** Accept public HTTPS GIF URLs from any provider; no provider hostname allowlist. */
export function isAllowedGifUrl(value: string | undefined | null): boolean {
  if (!value || typeof value !== 'string' || value.length > GIF_URL_MAX_LENGTH) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    // GIF providers use public DNS hostnames. Keep local addresses and credentials
    // out of externally shared links without maintaining a list of provider brands.
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      host.includes('.') &&
      host !== 'localhost' &&
      !host.endsWith('.localhost') &&
      !host.endsWith('.local') &&
      !isIP(host.replace(/^\[/, '').replace(/\]$/, ''))
    );
  } catch {
    return false;
  }
}
