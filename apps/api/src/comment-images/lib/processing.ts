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

function isGifBuffer(buf: Buffer): boolean {
  return buf.length > 5 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38;
}

export async function processImage(
  input: Buffer,
  opts: { maxLongEdge: number; quality: number; thumbMaxLongEdge: number; thumbQuality: number },
): Promise<ProcessedImage> {
  const { maxLongEdge, quality, thumbMaxLongEdge, thumbQuality } = opts;
  const { createHash } = await import('crypto');

  // GIFs: store the raw file as-is to preserve animation (sharp's animated WebP is unreliable
  // across environments). Only generate a thumbnail (first frame) and blurhash.
  if (isGifBuffer(input)) {
    const inputMeta = await sharp(input).metadata(); // first-frame dimensions

    const thumbBuf = await sharp(input, { failOn: 'error' })
      .rotate()
      .resize(thumbMaxLongEdge, thumbMaxLongEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: thumbQuality })
      .toBuffer();
    const thumbMeta = await sharp(thumbBuf).metadata();

    const blurhashImg = await sharp(input).rotate().resize(32, 32, { fit: 'inside' }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const hash = encode(new Uint8ClampedArray(blurhashImg.data), blurhashImg.info.width, blurhashImg.info.height, 4, 3);

    return {
      main: input, // raw GIF — no conversion, animation preserved
      thumbnail: thumbBuf,
      width: inputMeta.width ?? 0,
      height: inputMeta.height ?? 0,
      thumbWidth: thumbMeta.width ?? 0,
      thumbHeight: thumbMeta.height ?? 0,
      sha256: createHash('sha256').update(input).digest('hex'),
      blurhash: hash,
      mainSize: input.length,
      thumbSize: thumbBuf.length,
    };
  }

  // Non-GIF: resize, strip metadata, convert to WebP (existing pipeline)
  const mainBuf = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(maxLongEdge, maxLongEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  const meta = await sharp(mainBuf).metadata();

  const thumbBuf = await sharp(input, { failOn: 'error' })
    .rotate()
    .resize(thumbMaxLongEdge, thumbMaxLongEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: thumbQuality })
    .toBuffer();
  const thumbMeta = await sharp(thumbBuf).metadata();

  const blurhashImg = await sharp(input).rotate().resize(32, 32, { fit: 'inside' }).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const hash = encode(new Uint8ClampedArray(blurhashImg.data), blurhashImg.info.width, blurhashImg.info.height, 4, 3);

  return {
    main: mainBuf,
    thumbnail: thumbBuf,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    thumbWidth: thumbMeta.width ?? 0,
    thumbHeight: thumbMeta.height ?? 0,
    sha256: createHash('sha256').update(mainBuf).digest('hex'),
    blurhash: hash,
    mainSize: mainBuf.length,
    thumbSize: thumbBuf.length,
  };
}
