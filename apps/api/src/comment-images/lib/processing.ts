import sharp from 'sharp';
import { encode } from 'blurhash';

export interface ProcessedImage {
  main: Buffer;
  thumbnail: Buffer;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  sha256: string;
  blurhash: string;
  mainSize: number;
  thumbSize: number;
}

export async function processImage(
  input: Buffer,
  opts: { maxLongEdge: number; quality: number; thumbMaxLongEdge: number; thumbQuality: number },
): Promise<ProcessedImage> {
  const { maxLongEdge, quality, thumbMaxLongEdge, thumbQuality } = opts;

  // Main image: resize, strip metadata, convert to WebP
  const mainPipeline = sharp(input, { failOn: 'error' })
    .rotate()
    .resize(maxLongEdge, maxLongEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality });

  const mainBuf = await mainPipeline.toBuffer();
  const meta = await sharp(mainBuf).metadata();

  // Thumbnail
  const thumbBuf = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(thumbMaxLongEdge, thumbMaxLongEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: thumbQuality })
    .toBuffer();
  const thumbMeta = await sharp(thumbBuf).metadata();

  // Blurhash from a small version of the image
  const blurhashImg = await sharp(input).rotate().resize(32, 32, { fit: 'inside' }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const { data, info } = blurhashImg;
  const hash = encode(new Uint8ClampedArray(data), info.width, info.height, 4, 3);

  // SHA-256 of processed main image
  const { createHash } = await import('crypto');
  const sha256 = createHash('sha256').update(mainBuf).digest('hex');

  return {
    main: mainBuf,
    thumbnail: thumbBuf,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    thumbWidth: thumbMeta.width ?? 0,
    thumbHeight: thumbMeta.height ?? 0,
    sha256,
    blurhash: hash,
    mainSize: mainBuf.length,
    thumbSize: thumbBuf.length,
  };
}
