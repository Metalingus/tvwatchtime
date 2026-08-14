import { BadGatewayException } from '@nestjs/common';

const PROVIDER_TIMEOUT_MS = 30_000;

export async function providerJson<T>(
  provider: string,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new BadGatewayException(`${provider} could not be reached`);
  }
  if (!response.ok) {
    throw new BadGatewayException(`${provider} returned HTTP ${response.status}`);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new BadGatewayException(`${provider} returned an invalid response`);
  }
}

export function cleanExternalIds(value: unknown): {
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
} {
  const ids = (value ?? {}) as Record<string, unknown>;
  const rawImdb = ids.imdb ?? ids.Imdb;
  const imdb = typeof rawImdb === 'string' && /^tt\d+$/i.test(rawImdb) ? rawImdb : undefined;
  const numberId = (raw: unknown) => {
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };
  return {
    imdb,
    tmdb: numberId(ids.tmdb ?? ids.Tmdb),
    tvdb: numberId(ids.tvdb ?? ids.tvdb_id ?? ids.Tvdb),
  };
}

export function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
