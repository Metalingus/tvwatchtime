import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/** Public API delivery URL. MinIO objects and encryption metadata never leave the backend. */
export function publicCommentImageUrl(config: Pick<ConfigService, 'get'>, imageId: string): string {
  const configured = (config.get<string>('api.baseUrl') ?? '').replace(/\/+$/, '');
  let base: URL;
  try {
    base = new URL(configured);
  } catch {
    throw new BadRequestException('A public HTTPS API_BASE_URL is required for shared images');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash)
    throw new BadRequestException('A public HTTPS API_BASE_URL is required for shared images');
  const prefix = configured.endsWith('/api') ? configured : configured + '/api';
  return prefix + '/comment-images/' + encodeURIComponent(imageId);
}
