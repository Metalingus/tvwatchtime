import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CommentImageService } from './comment-image.service';

function makeService(commentRow: any) {
  const prisma: any = {
    comment: { findUnique: jest.fn().mockResolvedValue(commentRow) },
    commentImage: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn() },
  };
  const storage: any = { putTemp: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: jest.fn((k: string) => (k.includes('maxUploadMb') ? 5 : k.includes('uploadsPerUserPerDay') ? 20 : undefined)) };
  const events: any = { emit: jest.fn() };
  const svc = new CommentImageService(prisma, storage, config, events);
  return { svc, prisma, storage };
}

describe('CommentImageService.upload — GIF guard', () => {
  it('rejects image upload when comment already has a gifUrl', async () => {
    const { svc, storage } = makeService({ id: 'c1', userId: 'u1', gifUrl: 'https://media.giphy.com/media/abc/giphy.gif' });
    await expect(
      svc.upload('u1', 'c1', { buffer: Buffer.from(''), originalname: 'x.jpg', size: 1, mimetype: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(storage.putTemp).not.toHaveBeenCalled();
  });

  it('throws NotFound when comment missing', async () => {
    const { svc } = makeService(null);
    await expect(
      svc.upload('u1', 'c1', { buffer: Buffer.from(''), originalname: 'x.jpg', size: 1, mimetype: 'image/jpeg' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
