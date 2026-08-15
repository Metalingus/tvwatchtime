import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export function isPrivateAddress(address: string): boolean {
  const ipv6 = address.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const normalized = ipv6.replace(/^::ffff:/, '');
  if (normalized === '::' || normalized === '::1' || normalized === '0.0.0.0') return true;
  if (
    /^(fc|fd)/.test(normalized) ||
    /^fe[89ab]/.test(normalized) ||
    /^ff/.test(normalized) ||
    /^2001:db8(?::|$)/.test(normalized)
  )
    return true;
  const octets = normalized.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part))) return false;
  return (
    octets[0] === 10 ||
    octets[0] === 127 ||
    octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] >= 224
  );
}

export function normalizeMediaServerUrl(raw: string, provider: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new BadRequestException(`${provider} server URL is invalid`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new BadRequestException(`${provider} server URL is invalid`);
  }
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export async function assertAllowedMediaServerUrl(
  serverUrl: string,
  allowPrivate: boolean,
  provider: string,
): Promise<void> {
  if (allowPrivate) return;
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:') {
    throw new BadRequestException(`Public ${provider} URLs must use HTTPS`);
  }
  const hostname = url.hostname
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new BadRequestException(`Private ${provider} URLs are disabled on this server`);
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true }).catch(() => []);
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new BadRequestException(`Private ${provider} URLs are disabled on this server`);
  }
}
