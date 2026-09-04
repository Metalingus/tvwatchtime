import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { CapabilityService } from '../common/capability.service';
import {
  S3Client,
  PutObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { ArtworkGalleryService } from '../media-metadata/artwork-gallery.service';

const USER_BUCKET = 'tvwatch-user-images';
const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REMOTE_IMAGE_PIXELS = 40_000_000;
const ALLOWED_REMOTE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

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
    private readonly artworkGallery: ArtworkGalleryService,
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
    return this.uploadImage(userId, file, 'avatars', 400, 400);
  }

  async uploadCover(userId: string, file: { buffer: Buffer; mimetype: string }): Promise<string> {
    return this.uploadImage(userId, file, 'covers', 1280, 720);
  }

  async setCoverFromGallery(
    userId: string,
    ownerType: 'MEDIA' | 'EPISODE',
    ownerId: string | undefined,
    imageId: string,
    sourceKey?: string,
  ): Promise<string> {
    const source = await this.artworkGallery.resolveCoverSource(
      ownerType,
      ownerId,
      imageId,
      sourceKey,
    );
    const file = await this.downloadProviderImage(source.url, source.provider);
    return this.uploadCover(userId, file);
  }

  async readStoredImage(
    type: string,
    filename: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    if (!['avatars', 'covers'].includes(type) || !/^[A-Za-z0-9_-]+\.webp$/.test(filename)) {
      throw new NotFoundException('User image not found');
    }

    if (this.capabilities.userImageStorage === 's3') {
      try {
        const { client, bucket } = await this.getS3();
        const object = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: `${type}/${filename}` }),
        );
        const bytes = await object.Body?.transformToByteArray();
        if (bytes) {
          return {
            buffer: Buffer.from(bytes),
            contentType: object.ContentType || 'image/webp',
          };
        }
      } catch (error) {
        this.logger.debug(
          `S3 user image read missed ${type}/${filename}: ${(error as Error).message}`,
        );
      }
    }

    try {
      return {
        buffer: await readFile(join(this.storageDir, type, filename)),
        contentType: 'image/webp',
      };
    } catch {
      throw new NotFoundException('User image not found');
    }
  }

  private async uploadImage(
    userId: string,
    file: { buffer: Buffer; mimetype: string },
    type: 'avatars' | 'covers',
    width: number,
    height: number,
  ): Promise<string> {
    if (!file?.buffer) throw new BadRequestException('No file provided');

    let processed: Buffer;
    try {
      processed = await sharp(file.buffer, { limitInputPixels: MAX_REMOTE_IMAGE_PIXELS })
        .resize(width, height, {
          fit: 'cover',
          position: 'centre',
          // Covers are normalized to an exact 1280x720 asset. Keep the historical
          // no-upscale rule only for avatars, where a smaller square is acceptable.
          withoutEnlargement: type === 'avatars',
        })
        .webp({ quality: 90 })
        .toBuffer();
    } catch (e) {
      throw new BadRequestException(`Image processing failed: ${(e as Error).message}`);
    }

    const filename = `${userId}.webp`;

    if (this.capabilities.userImageStorage === 's3') {
      try {
        const storedUrl = await this.uploadToS3(type, filename, processed);
        const publicUrl = this.versionedUrl(storedUrl);
        await this.updateProfile(userId, type, publicUrl);
        return publicUrl;
      } catch (s3Err) {
        this.logger.warn(`S3 upload failed, falling back to local: ${(s3Err as Error).message}`);
      }
    }

    // Local file storage
    const dir = join(this.storageDir, type);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), processed);
    const baseUrl = this.config.get<string>('api.baseUrl') || '';
    const publicUrl = this.versionedUrl(`${baseUrl}/uploads/${type}/${filename}`);
    await this.updateProfile(userId, type, publicUrl);
    return publicUrl;
  }

  private versionedUrl(url: string) {
    return `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
  }

  private async downloadProviderImage(
    rawUrl: string,
    provider: ExternalProvider.TMDB | ExternalProvider.THE_TVDB,
  ): Promise<{ buffer: Buffer; mimetype: string }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid gallery image URL');
    }
    const expectedHost =
      provider === ExternalProvider.TMDB ? 'image.tmdb.org' : 'artworks.thetvdb.com';
    if (url.protocol !== 'https:' || url.hostname !== expectedHost) {
      throw new BadRequestException('Gallery image host is not allowed');
    }

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
        headers: { Accept: 'image/*' },
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Could not download gallery image: ${(error as Error).message}`,
      );
    }
    if (!response.ok) {
      throw new ServiceUnavailableException(`Gallery image returned HTTP ${response.status}`);
    }
    const mimetype = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
    if (!ALLOWED_REMOTE_IMAGE_TYPES.has(mimetype)) {
      throw new BadRequestException('Gallery source did not return an image');
    }
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_REMOTE_IMAGE_BYTES) {
      throw new BadRequestException('Gallery image is too large');
    }
    if (!response.body) throw new ServiceUnavailableException('Gallery image response was empty');

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response.body as any) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REMOTE_IMAGE_BYTES) {
        throw new BadRequestException('Gallery image is too large');
      }
      chunks.push(buffer);
    }
    return { buffer: Buffer.concat(chunks), mimetype };
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

  private async updateProfile(
    userId: string,
    type: 'avatars' | 'covers',
    url: string,
  ): Promise<void> {
    const field = type === 'avatars' ? 'avatarUrl' : 'coverUrl';
    await this.prisma.userProfile.upsert({
      where: { userId },
      create: { userId, [field]: url },
      update: { [field]: url },
    });
  }
}
