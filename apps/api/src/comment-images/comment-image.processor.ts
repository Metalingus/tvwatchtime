import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisService } from '../common/redis/redis.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { CommentImageStorage } from './lib/storage';
import { ModerationService } from './lib/moderation';
import { detectImageType } from './lib/validation';
import { processImage } from './lib/processing';
import { encryptImage, sha256 } from './lib/crypto';
import sharp from 'sharp';

export const COMMENT_IMAGE_QUEUE = 'comment-images';

@Injectable()
export class CommentImageProcessor implements OnModuleInit {
  private readonly logger = new Logger(CommentImageProcessor.name);
  private queue!: Queue;
  private worker!: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly storage: CommentImageStorage,
    private readonly moderation: ModerationService,
    private readonly config: ConfigService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    const connection = this.redis.client as any;
    const concurrency = this.config.get<number>('commentImages.workerConcurrency') ?? 2;

    this.queue = new Queue(COMMENT_IMAGE_QUEUE, { connection });

    // Listen for upload events and enqueue
    this.events.on('comment-image.uploaded', async (payload: { imageId: string }) => {
      await this.queue.add('process', { imageId: payload.imageId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
    });

    this.worker = new Worker(
      COMMENT_IMAGE_QUEUE,
      async (job) => this.process(job.data.imageId as string),
      { connection, concurrency },
    );
    this.worker.on('failed', (job, err) => this.logger.error(`Image job ${job?.id} failed: ${err.message}`));
  }

  private async setStatus(imageId: string, status: any, extra: Record<string, unknown> = {}) {
    await this.prisma.commentImage.update({ where: { id: imageId }, data: { status, ...extra } });
  }

  private async fail(imageId: string, message: string) {
    await this.setStatus(imageId, 'failed', { errorMessage: message.slice(0, 1000) });
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (img?.tempStorageKey) await this.storage.deleteTemp(img.tempStorageKey).catch(() => undefined);
  }

  private async reject(imageId: string, reason: string, moderationData?: any) {
    await this.setStatus(imageId, 'rejected', { rejectionReason: reason, ...moderationData });
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (img?.tempStorageKey) await this.storage.deleteTemp(img.tempStorageKey).catch(() => undefined);
  }

  async process(imageId: string) {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId }, include: { comment: true } });
    if (!img || !img.tempStorageKey) return;
    if (img.status === 'ready' || img.status === 'deleted') return;

    try {
      // 1. Load temp upload
      await this.setStatus(imageId, 'validating');
      const raw = await this.storage.getTemp(img.tempStorageKey);

      // 2. Validate file signature
      const detection = detectImageType(raw);
      if (!detection.ok) {
        await this.reject(imageId, 'This image format is not supported.');
        return;
      }
      await this.prisma.commentImage.update({ where: { id: imageId }, data: { detectedMimeType: detection.mime } });

      // 3. Decode + inspect with Sharp
      let metadata;
      try {
        metadata = await sharp(raw, { failOn: 'error' }).metadata();
      } catch {
        await this.reject(imageId, 'We couldn\u2019t process this image.');
        return;
      }
      const maxPixels = this.config.get<number>('commentImages.maxPixels')!;
      if (metadata.width && metadata.height && metadata.width * metadata.height > maxPixels) {
        await this.reject(imageId, 'This image is too large.');
        return;
      }

      // 4. OpenAI moderation (text + image)
      await this.setStatus(imageId, 'moderating');
      const modResult = await this.moderation.moderate(img.comment.body, raw, detection.mime);
      await this.prisma.commentImage.update({
        where: { id: imageId },
        data: {
          moderationProvider: 'openai',
          moderationModel: modResult.model,
          moderationFlagged: modResult.flagged,
          moderationCategories: modResult.categories,
          moderationCategoryScores: modResult.categoryScores,
          moderationDecision: modResult.decision,
        },
      });

      if (modResult.decision === 'reject') {
        await this.reject(imageId, 'This image doesn\u2019t meet our community guidelines.');
        return;
      }
      if (modResult.decision === 'needs_manual_review') {
        await this.setStatus(imageId, 'needs_manual_review');
        return;
      }

      // 5. Process image (Sharp → WebP)
      await this.setStatus(imageId, 'processing');
      const processed = await processImage(raw, {
        maxLongEdge: this.config.get<number>('commentImages.maxLongEdge')!,
        quality: this.config.get<number>('commentImages.webpQuality')!,
        thumbMaxLongEdge: this.config.get<number>('commentImages.thumbMaxLongEdge')!,
        thumbQuality: this.config.get<number>('commentImages.thumbWebpQuality')!,
      });

      // 6. Encrypt
      const masterKeyRaw = this.config.get<string>('commentImages.encryptionMasterKey')!;
      const masterKey = Buffer.from(masterKeyRaw, 'utf8').toString('hex').slice(0, 64);

      const encMain = encryptImage(processed.main, masterKey);
      const encThumb = encryptImage(processed.thumbnail, masterKey);

      // 7. Upload encrypted to S3 (GIFs stored as-is to preserve animation; thumb always WebP)
      const isGif = detection.mime === 'image/gif';
      const baseKey = `comments/${img.commentId}/images/${imageId}`;
      const mainKey = `${baseKey}.${isGif ? 'gif' : 'webp'}.enc`;
      const thumbKey = `${baseKey}_thumb.webp.enc`;
      await this.storage.putEncrypted(mainKey, encMain.ciphertext);
      await this.storage.putEncrypted(thumbKey, encThumb.ciphertext);

      // 8. Update DB → ready
      await this.setStatus(imageId, 'ready', {
        storageKey: mainKey,
        thumbnailStorageKey: thumbKey,
        encryptedDataKey: encMain.encryptedDataKey,
        iv: encMain.iv,
        authTag: encMain.authTag,
        thumbnailEncryptedDataKey: encThumb.encryptedDataKey,
        thumbnailIv: encThumb.iv,
        thumbnailAuthTag: encThumb.authTag,
        width: processed.width,
        height: processed.height,
        thumbnailWidth: processed.thumbWidth,
        thumbnailHeight: processed.thumbHeight,
        processedSizeBytes: processed.mainSize,
        thumbnailSizeBytes: processed.thumbSize,
        sha256Hash: processed.sha256,
        blurhash: processed.blurhash,
        processedAt: new Date(),
      });

      // 9. Cleanup temp
      await this.storage.deleteTemp(img.tempStorageKey);

      this.logger.log(`Image ${imageId} processed successfully`);
    } catch (err) {
      this.logger.error(`Image ${imageId} processing error: ${(err as Error).message}`);
      await this.fail(imageId, (err as Error).message);
    }
  }
}
