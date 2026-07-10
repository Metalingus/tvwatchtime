import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { CapabilityService } from '../common/capability.service';
import { S3Client, PutObjectCommand, HeadBucketCommand, CreateBucketCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';

const USER_BUCKET = 'tvwatch-user-images';

@Injectable()
export class UserImageService {
  private readonly logger = new Logger(UserImageService.name);
  private readonly storageDir: string;
  private s3Client: S3Client | null = null;
  private bucketsReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly capabilities: CapabilityService,
  ) {
    this.storageDir = join(process.cwd(), 'apps', 'api', 'storage');
  }

  private async getS3(): Promise<{ client: S3Client; bucket: string; publicBase: string }> {
    const endpoint = this.config.get<string>('commentImages.s3Endpoint');
    const region = this.config.get<string>('commentImages.s3Region') || 'us-east-1';
    const accessKeyId = this.config.get<string>('commentImages.s3AccessKeyId');
    const secretAccessKey = this.config.get<string>('commentImages.s3SecretAccessKey');

    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region,
        endpoint,
        forcePathStyle: !!endpoint,
        credentials: accessKeyId ? { accessKeyId, secretAccessKey: secretAccessKey! } : undefined,
      });
    }

    // Auto-create user images bucket once
    if (!this.bucketsReady) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: USER_BUCKET }));
      } catch {
        try {
          await this.s3Client.send(new CreateBucketCommand({ Bucket: USER_BUCKET }));
          this.logger.log(`Created S3 bucket: ${USER_BUCKET}`);
        } catch (e) {
          this.logger.warn(`Could not create bucket ${USER_BUCKET}: ${(e as Error).message}`);
        }
      }
      this.bucketsReady = true;
    }

    const publicBase = this.config.get<string>('storage.s3PublicBaseUrl') || '';
    return { client: this.s3Client, bucket: USER_BUCKET, publicBase };
  }

  async uploadAvatar(userId: string, file: { buffer: Buffer; mimetype: string }): Promise<string> {
    return this.uploadImage(userId, file, 'avatars', 400);
  }

  async uploadCover(userId: string, file: { buffer: Buffer; mimetype: string }): Promise<string> {
    return this.uploadImage(userId, file, 'covers', 1280);
  }

  private async uploadImage(
    userId: string,
    file: { buffer: Buffer; mimetype: string },
    type: 'avatars' | 'covers',
    maxEdge: number,
  ): Promise<string> {
    if (!file?.buffer) throw new BadRequestException('No file provided');

    let processed: Buffer;
    try {
      processed = await sharp(file.buffer)
        .resize(maxEdge, maxEdge, { fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer();
    } catch (e) {
      throw new BadRequestException(`Image processing failed: ${(e as Error).message}`);
    }

    const filename = `${userId}.webp`;

    if (this.capabilities.userImageStorage === 's3') {
      try {
        const url = await this.uploadToS3(type, filename, processed);
        await this.updateProfile(userId, type, url);
        return url;
      } catch (s3Err) {
        this.logger.warn(`S3 upload failed, falling back to local: ${(s3Err as Error).message}`);
      }
    }

    // Local file storage
    const dir = join(this.storageDir, type);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), processed);
    const baseUrl = this.config.get<string>('api.baseUrl') || '';
    const url = `${baseUrl}/uploads/${type}/${filename}`;
    await this.updateProfile(userId, type, url);
    return url;
  }

  private async uploadToS3(type: string, filename: string, buffer: Buffer): Promise<string> {
    const { client, bucket, publicBase } = await this.getS3();
    const key = `${type}/${filename}`; // avatars/xxx.webp, covers/xxx.webp

    await client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: 'image/webp' }),
    );

    if (publicBase) return `${publicBase}/${key}`;
    const apiBase = this.config.get<string>('api.baseUrl') || '';
    return `${apiBase}/uploads/${type}/${filename}`;
  }

  private async updateProfile(userId: string, type: 'avatars' | 'covers', url: string): Promise<void> {
    const field = type === 'avatars' ? 'avatarUrl' : 'coverUrl';
    await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, [field]: url },
      update: { [field]: url },
    });
  }
}
