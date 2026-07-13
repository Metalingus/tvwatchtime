import { BadRequestException, Injectable, Logger, NotFoundException, StreamableFile } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommentImageStorage } from './lib/storage';
import { encryptImage, decryptImage, sha256, type DecryptionMeta } from './lib/crypto';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';

@Injectable()
export class CommentImageService {
  private readonly logger = new Logger(CommentImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CommentImageStorage,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  async upload(userId: string, commentId: string, file: { buffer: Buffer; originalname: string; size: number; mimetype: string }) {
    // Validate comment exists and belongs to user
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId) throw new BadRequestException('You can only attach images to your own comments');

    // A comment may carry at most one visual attachment: image XOR GIPHY gif.
    if (comment.gifUrl) {
      throw new BadRequestException('A comment cannot contain both an image and a GIF');
    }

    // Check no existing image
    const existing = await this.prisma.commentImage.findUnique({ where: { commentId } });
    if (existing && existing.status !== 'deleted' && existing.status !== 'rejected') {
      throw new BadRequestException('This comment already has an image');
    }

    // Size check
    const maxBytes = this.config.get<number>('commentImages.maxUploadMb')! * 1024 * 1024;
    if (file.size > maxBytes) {
      throw new BadRequestException(`Image exceeds ${this.config.get('commentImages.maxUploadMb')}MB limit`);
    }

    // Daily rate limit
    const dailyLimit = this.config.get<number>('commentImages.uploadsPerUserPerDay')!;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await this.prisma.commentImage.count({ where: { userId, createdAt: { gte: since } } });
    if (todayCount >= dailyLimit) throw new BadRequestException(`Daily image upload limit (${dailyLimit}) reached`);

    // Save to temp storage
    const tempKey = `${commentId}/${randomUUID()}`;
    await this.storage.putTemp(tempKey, file.buffer);

    // Create record
    const img = await this.prisma.commentImage.create({
      data: {
        commentId,
        userId,
        status: 'uploaded',
        originalMimeType: file.mimetype,
        originalSizeBytes: file.size,
        uploadedSizeBytes: file.size,
        tempStorageKey: tempKey,
      },
    });

    // The processor will be triggered by the module's event/queue
    this.events.emit('comment-image.uploaded', { imageId: img.id });

    return { commentImageId: img.id, status: 'uploaded' };
  }

  async getStatus(userId: string, imageId: string) {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (!img) throw new NotFoundException('Image not found');
    const isOwner = img.userId === userId;
    return {
      id: img.id,
      status: img.status,
      width: img.width,
      height: img.height,
      blurhash: img.blurhash,
      imageReady: img.status === 'ready',
      thumbnailReady: img.status === 'ready',
      rejectionReason: isOwner ? img.rejectionReason : undefined,
      errorMessage: isOwner ? img.errorMessage : undefined,
    };
  }

  async serveImage(userId: string, imageId: string, thumbnail = false): Promise<StreamableFile> {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (!img || img.status === 'deleted') throw new NotFoundException('Image not found');
    if (img.status !== 'ready') throw new NotFoundException('Image not ready');

    const key = thumbnail ? img.thumbnailStorageKey : img.storageKey;
    if (!key) throw new NotFoundException('Image storage key missing');

    const meta: DecryptionMeta = {
      encryptedDataKey: thumbnail ? img.thumbnailEncryptedDataKey! : img.encryptedDataKey!,
      iv: thumbnail ? img.thumbnailIv! : img.iv!,
      authTag: thumbnail ? img.thumbnailAuthTag! : img.authTag!,
    };

    const encrypted = await this.storage.getEncrypted(key);
    const masterKey = Buffer.from(this.config.get<string>('commentImages.encryptionMasterKey')!, 'utf8').toString('hex').slice(0, 64);
    const decrypted = decryptImage(encrypted, meta, masterKey);

    const isGif = !thumbnail && key?.includes('.gif.enc');
    return new StreamableFile(Readable.from(decrypted), {
      type: isGif ? 'image/gif' : 'image/webp',
      disposition: 'inline',
      length: decrypted.length,
    });
  }

  async remove(userId: string, imageId: string) {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (!img) throw new NotFoundException('Image not found');
    if (img.userId !== userId) throw new BadRequestException('Not authorized');

    if (img.storageKey) await this.storage.deleteObject(img.storageKey).catch(() => undefined);
    if (img.thumbnailStorageKey) await this.storage.deleteObject(img.thumbnailStorageKey).catch(() => undefined);
    if (img.tempStorageKey) await this.storage.deleteTemp(img.tempStorageKey).catch(() => undefined);

    await this.prisma.commentImage.update({ where: { id: imageId }, data: { status: 'deleted', deletedAt: new Date() } });
    return { ok: true };
  }
}
