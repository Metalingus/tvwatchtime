// File signature / magic bytes validation — never trust extension or MIME header.
const SIGNATURES: { type: string; bytes: number[]; offset?: number }[] = [
  { type: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { type: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46], offset: 0 }, // RIFF... check further
  { type: 'image/heic', bytes: [0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63], offset: 4 }, // ftypheic at offset 4
  { type: 'image/heif', bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ftyp...
];

const BLOCKED_SIGNATURES = [
  [0x3c, 0x73, 0x76, 0x67], // <svg
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x50, 0x4b, 0x03, 0x04], // ZIP/PK
  [0x47, 0x49, 0x46, 0x38], // GIF8 (animated)
  [0x00, 0x00, 0x01, 0x00], // ICO
  [0x4d, 0x5a], // EXE (MZ)
];

export type DetectResult = { ok: true; mime: string } | { ok: false; reason: string };

export function detectImageType(buf: Buffer): DetectResult {
  if (buf.length < 16) return { ok: false, reason: 'File too small to be a valid image' };

  // Reject known dangerous types
  for (const sig of BLOCKED_SIGNATURES) {
    if (sig.every((b, i) => buf[i] === b)) {
      return { ok: false, reason: `Blocked file type detected (magic bytes match known dangerous format)` };
    }
  }

  // Check supported image signatures
  for (const sig of SIGNATURES) {
    const off = sig.offset ?? 0;
    if (buf.length < off + sig.bytes.length) continue;
    if (sig.bytes.every((b, i) => buf[off + i] === b)) {
      // Special case: WebP is RIFF....WEBP
      if (sig.type === 'image/webp') {
        if (buf.length >= 12 && buf.slice(8, 12).toString('ascii') === 'WEBP') {
          return { ok: true, mime: 'image/webp' };
        }
        continue; // RIFF but not WEBP
      }
      if (sig.type === 'image/heif') {
        const ftyp = buf.slice(4, 8).toString('ascii');
        if (ftyp === 'heic' || ftyp === 'heix' || ftyp === 'mif1') return { ok: true, mime: 'image/heic' };
        continue;
      }
      return { ok: true, mime: sig.type };
    }
  }

  return { ok: false, reason: 'Unrecognized file format — magic bytes do not match any supported image type' };
}
