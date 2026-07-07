import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class CommentImageStorage {
  private readonly logger = new Logger(CommentImageStorage.name);
  private client: S3Client | null = null;
  private readonly bucket: string;
  private readonly tempBucket: string;
  private readonly endpoint: string | undefined;
  private readonly region: string;
  private readonly accessKeyId: string | undefined;
  private readonly secretAccessKey: string | undefined;

  constructor(config: ConfigService) {
    this.bucket = config.get<string>('commentImages.s3Bucket')!;
    this.tempBucket = config.get<string>('commentImages.s3TempBucket')!;
    this.endpoint = config.get<string>('commentImages.s3Endpoint');
    this.region = config.get<string>('commentImages.s3Region')!;
    this.accessKeyId = config.get<string>('commentImages.s3AccessKeyId');
    this.secretAccessKey = config.get<string>('commentImages.s3SecretAccessKey');
  }

  private getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: this.region,
        endpoint: this.endpoint,
        forcePathStyle: !!this.endpoint,
        credentials: this.accessKeyId
          ? { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey! }
          : undefined,
      });
    }
    return this.client;
  }

  async putTemp(key: string, body: Buffer): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.tempBucket, Key: key, Body: body }),
    );
  }

  async getTemp(key: string): Promise<Buffer> {
    const res = await this.getClient().send(
      new GetObjectCommand({ Bucket: this.tempBucket, Key: key }),
    );
    return this.streamToBuffer(res.Body as Readable);
  }

  async putEncrypted(key: string, body: Buffer): Promise<void> {
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }),
    );
  }

  async getEncrypted(key: string): Promise<Buffer> {
    const res = await this.getClient().send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return this.streamToBuffer(res.Body as Readable);
  }

  async deleteTemp(key: string): Promise<void> {
    try {
      await this.getClient().send(new DeleteObjectCommand({ Bucket: this.tempBucket, Key: key }));
    } catch { /* best-effort */ }
  }

  async deleteObject(key: string): Promise<void> {
    try {
      await this.getClient().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch { /* best-effort */ }
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
}
