import { fenceIdentityWrite } from '../media-metadata/util/identity-write-fence';
import { canonicalCopyId } from '../media-metadata/util/canonical-media';
import type { Response } from 'express';
import { requiresLocalRevision } from '../commsuni/commsuni.comment-identity';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  StreamableFile,
} from '@nestjs/common';
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

  async upload(
    userId: string,
    commentId: string,
    file: { buffer: Buffer; originalname: string; size: number; mimetype: string },
    allowSharedLocalEdit = true,
  ) {
    commentId = await canonicalCopyId(this.prisma, 'COMMENT', commentId);
    // Validate comment exists and belongs to user
    const comment = await this.prisma.comment.findUnique({ where: { id: commentId } });
    if (!comment) throw new NotFoundException('Comment not found');
    if (comment.userId !== userId)
      throw new BadRequestException('You can only attach images to your own comments');
    if (
      comment.commsUniState &&
      comment.commsUniState !== 'WAITING_ATTACHMENT' &&
      !allowSharedLocalEdit &&
      !comment.hasLocalRevision
    )
      throw new BadRequestException('Shared attachments must be finalized before publication');

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
      throw new BadRequestException(
        `Image exceeds ${this.config.get('commentImages.maxUploadMb')}MB limit`,
      );
    }

    // Daily rate limit
    const dailyLimit = this.config.get<number>('commentImages.uploadsPerUserPerDay')!;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const todayCount = await this.prisma.commentImage.count({
      where: { userId, createdAt: { gte: since } },
    });
    if (todayCount >= dailyLimit)
      throw new BadRequestException(`Daily image upload limit (${dailyLimit}) reached`);

    // Save to temp storage
    const tempKey = `${commentId}/${randomUUID()}`;
    await this.storage.putTemp(tempKey, file.buffer);

    // Keep the old comment id while giving each replacement upload its own image id.
    // A detached published image retains its owner and immutable public URL.
    let img;
    try {
      img = await this.prisma.$transaction(async (tx) => {
        await fenceIdentityWrite(tx, {
          mediaIds: [
            ...(comment.mediaId ? [comment.mediaId] : []),
            ...(['SHOW', 'MOVIE'].includes(comment.threadType) ? [comment.threadId] : []),
          ],
          episodeIds: comment.threadType === 'EPISODE' ? [comment.threadId] : [],
        });
        await tx.$queryRawUnsafe('SELECT id FROM comments WHERE id = $1 FOR UPDATE', commentId);
        const current = await tx.comment.findUnique({
          where: { id: commentId },
          include: { image: true },
        });
        if (
          !current ||
          current.userId !== userId ||
          current.deletedByUser ||
          current.adminDeleted ||
          current.gifUrl
        )
          throw new BadRequestException('Comment no longer accepts an image');
        if (
          current.commsUniState &&
          current.commsUniState !== 'WAITING_ATTACHMENT' &&
          !allowSharedLocalEdit &&
          !current.hasLocalRevision
        )
          throw new BadRequestException('Shared attachments must be finalized before publication');
        if (current.image && !['deleted', 'rejected'].includes(current.image.status))
          throw new BadRequestException('This comment already has an image');
        if (current.image) {
          await tx.commentImage.update({
            where: { id: current.image.id },
            data: { commentId: null, retainedCommentId: commentId },
          });
        }
        const created = await tx.commentImage.create({
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
        if (requiresLocalRevision(current) && current.commsUniState !== 'WAITING_ATTACHMENT') {
          await tx.comment.update({ where: { id: commentId }, data: { hasLocalRevision: true } });
        }
        return created;
      });
    } catch (error) {
      await this.storage.deleteTemp(tempKey).catch(() => undefined);
      throw error;
    }

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

  async serveImage(
    userId: string,
    imageId: string,
    thumbnail = false,
    http?: { ifNoneMatch?: string; response: Pick<Response, 'setHeader' | 'status'> },
  ): Promise<StreamableFile> {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (!img || img.status === 'deleted') throw new NotFoundException('Image not found');
    if (img.status !== 'ready') throw new NotFoundException('Image not ready');
    const ownerId = img.commentId ?? img.retainedCommentId;
    if (!ownerId) throw new NotFoundException('Image not found');
    const owner = await this.prisma.comment.findUnique({
      where: { id: ownerId },
      select: { hidden: true, adminDeleted: true, deletedByUser: true },
    });
    if (!owner || owner.hidden || owner.adminDeleted || owner.deletedByUser)
      throw new NotFoundException('Image not found');

    const key = thumbnail ? img.thumbnailStorageKey : img.storageKey;
    if (!key) throw new NotFoundException('Image storage key missing');

    const meta: DecryptionMeta = {
      encryptedDataKey: thumbnail ? img.thumbnailEncryptedDataKey! : img.encryptedDataKey!,
      iv: thumbnail ? img.thumbnailIv! : img.iv!,
      authTag: thumbnail ? img.thumbnailAuthTag! : img.authTag!,
    };

    if (http) {
      const etag = '"' + sha256(Buffer.from(key + ':' + meta.authTag)) + '"';
      // Revalidate visibility on every request, but reuse client/CDN bytes when still visible.
      http.response.setHeader('Cache-Control', 'public, no-cache');
      http.response.setHeader('ETag', etag);
      const matches = http.ifNoneMatch
        ?.split(',')
        .some((value) => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag);
      if (matches) {
        http.response.status(304);
        return new StreamableFile(Buffer.alloc(0));
      }
    }

    const encrypted = await this.storage.getEncrypted(key);
    const masterKey = Buffer.from(
      this.config.get<string>('commentImages.encryptionMasterKey')!,
      'utf8',
    )
      .toString('hex')
      .slice(0, 64);
    const decrypted = decryptImage(encrypted, meta, masterKey);

    const isGif = !thumbnail && key?.includes('.gif.enc');
    return new StreamableFile(Readable.from(decrypted), {
      type: isGif ? 'image/gif' : 'image/webp',
      disposition: 'inline',
      length: decrypted.length,
    });
  }

  async remove(userId: string, imageId: string, allowSharedLocalEdit = true) {
    const img = await this.prisma.commentImage.findUnique({ where: { id: imageId } });
    if (!img) throw new NotFoundException('Image not found');
    if (img.userId !== userId) throw new BadRequestException('Not authorized');
    const ownerId = img.commentId ?? img.retainedCommentId;
    if (!ownerId) throw new NotFoundException('Image not found');
    const comment = await this.prisma.comment.findUnique({ where: { id: ownerId } });
    if (
      comment?.commsUniState &&
      !comment.deletedByUser &&
      !comment.adminDeleted &&
      !allowSharedLocalEdit &&
      !comment.hasLocalRevision
    )
      throw new BadRequestException('Published attachments cannot be edited');

    if (comment && !comment.deletedByUser && !comment.adminDeleted) {
      const retained = await this.prisma.$transaction(async (tx) => {
        await fenceIdentityWrite(tx, {
          mediaIds: [
            ...(comment.mediaId ? [comment.mediaId] : []),
            ...(['SHOW', 'MOVIE'].includes(comment.threadType) ? [comment.threadId] : []),
          ],
          episodeIds: comment.threadType === 'EPISODE' ? [comment.threadId] : [],
        });
        await tx.$queryRawUnsafe('SELECT id FROM comments WHERE id = $1 FOR UPDATE', ownerId);
        const current = await tx.commentImage.findUnique({ where: { id: imageId } });
        if (!current) return false;
        if (current.retainedCommentId) {
          if (current.commentId)
            await tx.commentImage.update({
              where: { id: imageId },
              data: { commentId: null },
            });
          await tx.comment.update({ where: { id: ownerId }, data: { hasLocalRevision: true } });
          return true;
        }
        if (requiresLocalRevision(comment)) {
          await tx.comment.update({ where: { id: ownerId }, data: { hasLocalRevision: true } });
        }
        // Prevent a concurrent backfill from pinning this image after deletion begins.
        await tx.commentImage.update({
          where: { id: imageId },
          data: { status: 'deleted', deletedAt: new Date() },
        });
        return false;
      });
      if (retained) return { ok: true };
    }

    // A one-to-two episode split clones the CommentImage row while reusing the same
    // immutable encrypted blobs. Delete a blob only after the last live row releases it;
    // the two cloned comments otherwise remain independent (including deletion state).
    if (
      img.storageKey &&
      (await this.prisma.commentImage.count({
        where: { id: { not: img.id }, status: { not: 'deleted' }, storageKey: img.storageKey },
      })) === 0
    ) {
      await this.storage.deleteObject(img.storageKey).catch(() => undefined);
    }
    if (
      img.thumbnailStorageKey &&
      (await this.prisma.commentImage.count({
        where: {
          id: { not: img.id },
          status: { not: 'deleted' },
          thumbnailStorageKey: img.thumbnailStorageKey,
        },
      })) === 0
    ) {
      await this.storage.deleteObject(img.thumbnailStorageKey).catch(() => undefined);
    }
    if (
      img.tempStorageKey &&
      (await this.prisma.commentImage.count({
        where: {
          id: { not: img.id },
          status: { not: 'deleted' },
          tempStorageKey: img.tempStorageKey,
        },
      })) === 0
    ) {
      await this.storage.deleteTemp(img.tempStorageKey).catch(() => undefined);
    }

    await this.prisma.commentImage.update({
      where: { id: imageId },
      data: { status: 'deleted', deletedAt: new Date() },
    });
    return { ok: true };
  }
}
