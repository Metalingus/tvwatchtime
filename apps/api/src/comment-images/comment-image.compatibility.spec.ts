import { CommentImageProcessor } from './comment-image.processor';
jest.mock('./lib/processing', () => ({
  processImage: jest.fn(async () => ({
    main: Buffer.from('processed'),
    thumbnail: Buffer.from('thumbnail'),
    width: 1,
    height: 1,
    thumbWidth: 1,
    thumbHeight: 1,
    mainSize: 9,
    thumbSize: 9,
    sha256: 'hash',
    blurhash: 'blur',
  })),
}));

function fixture() {
  const original = Buffer.from('immutable encrypted original');
  const objects = new Map([['original.webp.enc', original]]);
  const db: any = {
    commentImage: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn(),
    },
    comment: { findUnique: jest.fn().mockResolvedValue({ hasLocalRevision: true }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  db.$transaction = jest.fn(async (fn) => fn(db));
  const storage: any = {
    putEncrypted: jest.fn(async (key, value) => objects.set(key, value)),
    deleteObject: jest.fn(async (key) => objects.delete(key)),
  };
  const config: any = {
    get: (key: string) =>
      key === 'commentImages.encryptionMasterKey' ? 'image-test-key'.padEnd(32, 'x') : 100,
  };
  const service = new CommentImageProcessor({} as any, db, storage, {} as any, config, {} as any);
  return { db, objects, original, storage, service };
}
it('discards a stale processing result without overwriting the retained shared image', async () => {
  const f = fixture();
  await (f.service as any).storeReady(
    'old-image',
    'comment',
    'user',
    Buffer.from('raw'),
    'image/png',
  );
  expect(f.objects.size).toBe(1);
  expect(f.objects.get('original.webp.enc')).toBe(f.original);
  expect(f.db.commentImage.updateMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: 'old-image', commentId: 'comment', status: 'processing' },
    }),
  );
  expect(
    f.storage.putEncrypted.mock.calls.every(([key]: any[]) => key !== 'original.webp.enc'),
  ).toBe(true);
});
it('does not let a reimport replace a local revision', async () => {
  const f = fixture();
  await (f.service as any).storeReady(
    'import-image',
    'comment',
    'user',
    Buffer.from('raw'),
    'image/png',
    true,
  );
  expect(f.db.commentImage.upsert).not.toHaveBeenCalled();
  expect(f.objects.size).toBe(1);
  expect(f.objects.get('original.webp.enc')).toBe(f.original);
});
