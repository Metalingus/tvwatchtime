import AdmZip from 'adm-zip';
import { IMPORT_LIMITS } from './limits';
import { UnsafeArchiveError, InvalidUploadError } from '../errors';

export interface ZipEntry {
  filename: string;
  size: number;
  isSupported: boolean; // csv or json
  getData: () => Buffer;
}

/**
 * Safely inspect a ZIP: reject encrypted/nested/path-traversal/bombs,
 * enforce file count + uncompressed size limits, and only allow CSV/JSON inside.
 */
export function inspectZip(bytes: Buffer): { entries: ZipEntry[] } {
  let zip: AdmZip;
  try {
    zip = new AdmZip(bytes);
  } catch {
    throw new InvalidUploadError('File is not a valid ZIP archive');
  }

  const entries = zip.getEntries();
  if (entries.length === 0) throw new InvalidUploadError('ZIP archive is empty');
  if (entries.length > IMPORT_LIMITS.MAX_FILES) {
    throw new UnsafeArchiveError(`ZIP contains too many files (${entries.length} > ${IMPORT_LIMITS.MAX_FILES})`);
  }

  let totalUncompressed = 0;
  const out: ZipEntry[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const name = entry.entryName;
    // Path traversal / absolute path guard
    if (/(^|\/)\.\.(\/|$)/.test(name) || /^[a-zA-Z]:/.test(name) || name.startsWith('/')) {
      throw new UnsafeArchiveError(`ZIP entry uses an unsafe path: ${name}`);
    }
    // No nested archives
    if (name.toLowerCase().endsWith('.zip')) {
      throw new UnsafeArchiveError('Nested ZIP files are not allowed');
    }
    // Encrypted entries
    if ((entry.header.flags & 0x1) === 0x1) {
      throw new UnsafeArchiveError('Encrypted ZIP entries are not allowed');
    }

    const size = entry.header.size;
    totalUncompressed += size;
    if (totalUncompressed > IMPORT_LIMITS.MAX_UNCOMPRESSED_BYTES) {
      throw new UnsafeArchiveError('ZIP uncompressed size exceeds the limit (possible ZIP bomb)');
    }

    const ext = name.split('.').pop()!.toLowerCase();
    out.push({
      filename: name,
      size,
      isSupported: ext === 'csv' || ext === 'json',
      getData: () => entry.getData(),
    });
  }

  return { entries: out };
}
