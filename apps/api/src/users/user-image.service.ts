import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { CapabilityService } from '../common/capability.service';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { join } from 'path';
import { mkdir, writeFile } from 'fs/promises';

@Injectable()
export class UserImageService {
  private readonly logger = new Logger(UserImageService.name);
  private readonly storageDir: string;
  private s3Client: S3Client | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly capabilities: CapabilityService,
  ) {
    this.storageDir = join(process.cwd(), 'storage');
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

    const processed = await sharp(file.buffer)
      .resize(maxEdge, maxEdge, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();

    const filename = `${userId}.webp`;

    if (this.capabilities.userImageStorage === 's3') {
      const url = await this.uploadToS3(type, filename, processed);
      await this.updateProfile(userId, type, url);
      return url;
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
    const endpoint = this.config.get<string>('commentImages.s3Endpoint');
    const region = this.config.get<string>('commentImages.s3Region') || 'us-east-1';
    const accessKeyId = this.config.get<string>('commentImages.s3AccessKeyId');
    const secretAccessKey = this.config.get<string>('commentImages.s3SecretAccessKey');
    const bucket = `tvwatch-user-images`;

    if (!this.s3Client) {
      this.s3Client = new S3Client({
        region,
        endpoint,
        forcePathStyle: !!endpoint,
        credentials: accessKeyId ? { accessKeyId, secretAccessKey: secretAccessKey! } : undefined,
      });
    }

    await this.s3Client.send(
      new PutObjectCommand({ Bucket: bucket, Key: `${type}/${filename}`, Body: buffer, ContentType: 'image/webp' }),
    );

    const publicBase = this.config.get<string>('storage.s3PublicBaseUrl');
    if (publicBase) return `${publicBase}/${type}/${filename}`;
    if (endpoint) return `${endpoint}/${bucket}/${type}/${filename}`;
    return `https://${bucket}.s3.${region}.amazonaws.com/${type}/${filename}`;
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
