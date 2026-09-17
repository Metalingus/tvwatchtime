import 'reflect-metadata';
import { CommentImageService } from './comment-image.service';
import { CommentImageController } from './comment-image.controller';
import { encryptImage } from './lib/crypto';
import { publicCommentImageUrl } from './lib/public-url';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';

it.each(['serve', 'serveThumb'])('marks %s as public for partner readers', (method) => {
  expect(
    Reflect.getMetadata(IS_PUBLIC_KEY, (CommentImageController.prototype as any)[method]),
  ).toBe(true);
});
it.each(['https://api.example.test', 'https://api.example.test/api/'])(
  'creates a stable API image URL from %s',
  (base) => {
    expect(publicCommentImageUrl({ get: () => base } as any, 'image-1')).toBe(
      'https://api.example.test/api/comment-images/image-1',
    );
  },
);
it.each([
  'http://api.example.test',
  'https://user:password@example.test',
  'https://api.example.test?token=secret',
])('rejects a non-public-sharing URL configuration %s', (base) => {
  expect(() => publicCommentImageUrl({ get: () => base } as any, 'image-1')).toThrow();
});
it('serves decrypted GIF bytes to an anonymous partner reader while MinIO retains ciphertext', async () => {
  const key = 'test-only-image-key'.padEnd(32, 'x');
  const bytes = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const encrypted = encryptImage(bytes, Buffer.from(key).toString('hex').slice(0, 64));
  const db: any = {
    commentImage: {
      findUnique: jest.fn(async () => ({
        id: 'image',
        commentId: 'comment',
        status: 'ready',
        storageKey: 'private/image.gif.enc',
        ...encrypted,
      })),
    },
    comment: {
      findUnique: jest.fn(async () => ({
        hidden: false,
        adminDeleted: false,
        deletedByUser: false,
      })),
    },
  };
  const storage: any = { getEncrypted: jest.fn(async () => encrypted.ciphertext) };
  const service = new CommentImageService(db, storage, { get: () => key } as any, {} as any);
  const headers = new Map<string, string>();
  const response: any = {
    setHeader: jest.fn((key, value) => headers.set(key, value)),
    status: jest.fn(),
  };
  const file = await service.serveImage('public', 'image', false, { response });
  const chunks: Buffer[] = [];
  for await (const chunk of file.getStream()) chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks)).toEqual(bytes);
  expect(encrypted.ciphertext).not.toEqual(bytes);
  expect(file.getHeaders()).toMatchObject({
    type: 'image/gif',
    disposition: 'inline',
    length: bytes.length,
  });
  expect(headers.get('Cache-Control')).toBe('public, no-cache');
  const etag = headers.get('ETag')!;
  expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
  for (const ifNoneMatch of [etag, 'W/' + etag, '"unrelated", ' + etag, '*']) {
    await service.serveImage('public', 'image', false, { response, ifNoneMatch });
    expect(response.status).toHaveBeenLastCalledWith(304);
  }
  expect(storage.getEncrypted).toHaveBeenCalledTimes(1);
  // A stale validator must still deliver bytes.
  await service.serveImage('public', 'image', false, { response, ifNoneMatch: '"old"' });
  expect(storage.getEncrypted).toHaveBeenCalledTimes(2);
  db.comment.findUnique.mockResolvedValue({ deletedByUser: true });
  await expect(
    service.serveImage('public', 'image', false, { response, ifNoneMatch: etag }),
  ).rejects.toThrow('Image not found');
  expect(storage.getEncrypted).toHaveBeenCalledTimes(2);
  await expect(service.serveImage('public', 'image')).rejects.toThrow('Image not found');
});
