import { BadRequestException } from '@nestjs/common';
import type { CommsUniWriteComment } from '@tvwatch/shared';
import { UUID } from './commsuni.client';
import { isAllowedGifUrl } from '../common/utils/gif-url';

export function validateWrite(
  body: CommsUniWriteComment,
  mediaHosts: string[],
  now = Date.now(),
): void {
  if (
    body.text != null &&
    (typeof body.text !== 'string' ||
      [...body.text].length > 8000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.text))
  )
    throw new BadRequestException('Invalid comment text');
  if (!body.text?.trim() && !body.attachments?.length)
    throw new BadRequestException('Comment is empty');
  const timestamp = Date.parse(body.createdAt);
  if (
    !/(Z|[+-]\d{2}:\d{2})$/i.test(body.createdAt) ||
    !Number.isFinite(timestamp) ||
    timestamp < Date.UTC(2010, 0, 1) ||
    timestamp > now + 300000
  )
    throw new BadRequestException('Invalid comment timestamp');
  if ((body.attachments?.length ?? 0) > 1 || (body.mentions?.length ?? 0) > 3)
    throw new BadRequestException('Too many attachments or mentions');
  if (
    body.rating != null &&
    (typeof body.rating !== 'number' ||
      !Number.isFinite(body.rating) ||
      body.rating < 0 ||
      body.rating > 10)
  )
    throw new BadRequestException('Invalid rating');
  for (const attachment of body.attachments ?? []) {
    let url: URL;
    try {
      url = new URL(attachment.url);
    } catch {
      throw new BadRequestException('Invalid attachment URL');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      (attachment.contentType === 'image/gif'
        ? !isAllowedGifUrl(attachment.url)
        : !mediaHosts.includes(url.hostname.toLowerCase())) ||
      !['image/gif', 'image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(
        attachment.contentType,
      ) ||
      !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(attachment.provider)
    )
      throw new BadRequestException('Attachment host or format is not approved');
  }
  for (const mention of body.mentions ?? []) {
    if (
      !UUID.test(mention.authorId) ||
      !Number.isInteger(mention.start) ||
      !Number.isInteger(mention.end) ||
      mention.start < 0 ||
      mention.end <= mention.start ||
      body.text?.slice(mention.start, mention.end) !== mention.text
    )
      throw new BadRequestException('Invalid mention');
  }
}
