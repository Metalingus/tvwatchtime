import { BadRequestException } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { UserImageService } from './user-image.service';
import sharp from 'sharp';

describe('UserImageService gallery covers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function setup(url = 'https://image.tmdb.org/t/p/original/cover.jpg') {
    const gallery = {
      resolveCoverSource: jest.fn().mockResolvedValue({ url, provider: ExternalProvider.TMDB }),
    };
    const service = new UserImageService(
      {} as any,
      { get: jest.fn() } as any,
      { userImageStorage: 'local' } as any,
      gallery as any,
    );
    jest.spyOn(service, 'uploadCover').mockResolvedValue('/uploads/covers/user.webp');
    return { service, gallery };
  }

  it('downloads only the validated stored gallery image and passes it to cover processing', async () => {
    const { service, gallery } = setup();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
      }),
    );

    await expect(service.setCoverFromGallery('user', 'MEDIA', 'image')).resolves.toBe(
      '/uploads/covers/user.webp',
    );

    expect(gallery.resolveCoverSource).toHaveBeenCalledWith('MEDIA', 'image');
    expect(global.fetch).toHaveBeenCalledWith(
      new URL('https://image.tmdb.org/t/p/original/cover.jpg'),
      expect.objectContaining({ redirect: 'error' }),
    );
    expect(service.uploadCover).toHaveBeenCalledWith(
      'user',
      expect.objectContaining({ buffer: Buffer.from([1, 2, 3]), mimetype: 'image/jpeg' }),
    );
  });

  it('rejects a stored URL whose host does not match the authority provider', async () => {
    const { service } = setup('https://example.com/cover.jpg');
    global.fetch = jest.fn();

    await expect(service.setCoverFromGallery('user', 'MEDIA', 'image')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects provider responses over the ten-megabyte limit before reading the body', async () => {
    const { service } = setup();
    global.fetch = jest.fn().mockResolvedValue(
      new Response(Buffer.from([1]), {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(10 * 1024 * 1024 + 1),
        },
      }),
    );

    await expect(service.setCoverFromGallery('user', 'MEDIA', 'image')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(service.uploadCover).not.toHaveBeenCalled();
  });

  it('normalizes covers to an exact 1280x720 WebP', async () => {
    const prisma = { userProfile: { upsert: jest.fn() } };
    const service = new UserImageService(
      prisma as any,
      { get: jest.fn() } as any,
      { userImageStorage: 's3' } as any,
      {} as any,
    );
    jest.spyOn(service as any, 'uploadToS3').mockImplementation(async (...args: unknown[]) => {
      const buffer = args[2] as Buffer;
      const metadata = await sharp(buffer).metadata();
      expect(metadata.width).toBe(1280);
      expect(metadata.height).toBe(720);
      expect(metadata.format).toBe('webp');
      return 'https://storage.example/covers/user.webp';
    });
    const input = await sharp({
      create: { width: 20, height: 30, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();

    await expect(
      service.uploadCover('user', { buffer: input, mimetype: 'image/png' }),
    ).resolves.toMatch(/^https:\/\/storage\.example\/covers\/user\.webp\?v=\d+$/);
    expect(prisma.userProfile.upsert).toHaveBeenCalled();
  });

  it('serves an S3-backed cover through the public uploads fallback', async () => {
    const service = new UserImageService(
      {} as any,
      { get: jest.fn() } as any,
      { userImageStorage: 's3' } as any,
      {} as any,
    );
    const send = jest.fn().mockResolvedValue({
      Body: { transformToByteArray: jest.fn().mockResolvedValue(Uint8Array.from([4, 5, 6])) },
      ContentType: 'image/webp',
    });
    jest.spyOn(service as any, 'getS3').mockResolvedValue({
      client: { send },
      bucket: 'tvwatch-user-images',
      publicBase: '',
    });

    await expect(service.readStoredImage('covers', 'user.webp')).resolves.toEqual({
      buffer: Buffer.from([4, 5, 6]),
      contentType: 'image/webp',
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: 'tvwatch-user-images', Key: 'covers/user.webp' },
      }),
    );
  });
});
