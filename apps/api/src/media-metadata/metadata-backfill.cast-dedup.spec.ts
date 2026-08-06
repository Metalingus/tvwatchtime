import { MetadataBackfillService } from './metadata-backfill.service';
import { CastDedupService } from './cast-dedup.service';

// Cast-dedup: grouping confidence, canonical selection, and the vote-preserving
// merge flow (votes re-pointed BEFORE any duplicate row is deleted).

function mockRedis() {
  return {
    client: {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    },
    get: jest.fn().mockResolvedValue(null),
  } as any;
}

function makeSvc(prisma: any) {
  return new MetadataBackfillService(
    prisma,
    {} as any, // meta
    {} as any, // hydration
    mockRedis(),
    {} as any, // tmdb client
    {} as any, // tvdb provider
    {} as any, // tmdb provider
    {} as any, // structureRemap
    new CastDedupService(),
  );
}

type Row = {
  id: string;
  castMemberId: string;
  character: string | null;
  characterExternalId: number | null;
  sortOrder: number;
  characters: unknown;
  castMember: { id: string; name: string; externalId: string | null };
  _count: { characterVotes: number };
};

const row = (partial: Partial<Row> & { id: string }): Row => ({
  castMemberId: `cm-${partial.id}`,
  character: 'Goku',
  characterExternalId: null,
  sortOrder: 0,
  characters: null,
  castMember: { id: `cm-${partial.id}`, name: 'Masako Nozawa', externalId: 'TMDB_123' },
  _count: { characterVotes: 0 },
  ...partial,
});

describe('cast dedup grouping', () => {
  const svc = new CastDedupService();

  it('groups rows sharing a cast member as HIGH confidence', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'A', externalId: 'TMDB_1' },
      }),
      row({
        id: 'b',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'A', externalId: 'TMDB_1' },
        sortOrder: 1,
      }),
      row({
        id: 'c',
        castMemberId: 'cm-2',
        character: 'Vegeta',
        castMember: { id: 'cm-2', name: 'B', externalId: 'TMDB_2' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
    expect(groups[0].rows.map((r: Row) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('groups rows sharing a TVDB characterExternalId as HIGH confidence', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({ id: 'a', characterExternalId: 777 }),
      row({
        id: 'b',
        characterExternalId: 777,
        castMemberId: 'cm-x',
        castMember: { id: 'cm-x', name: 'A', externalId: 'TVDB_999' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
  });

  it('groups same-name actor + same character as HIGH (safe merge within one media)', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({ id: 'a', castMember: { id: 'cm-1', name: 'Masako Nozawa', externalId: 'TMDB_100' } }),
      row({
        id: 'b',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: '  MASAKO  NOZAWA ', externalId: 'TVDB_200' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
  });

  it('groups prefix-variant character names ("Matt Murdock" vs "Matt Murdock / Daredevil") as HIGH', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Matt Murdock',
        castMember: { id: 'cm-1', name: 'Charlie Cox', externalId: 'TMDB_100' },
      }),
      row({
        id: 'b',
        character: 'Matt Murdock / Daredevil',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Charlie Cox', externalId: 'TVDB_200' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
    expect(groups[0].rows).toHaveLength(2);
  });

  it('merges cross-provider similar characters ("Juliette" vs "Juliette Nichols") as HIGH', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Juliette',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Rebecca Ferguson', externalId: 'TMDB_100' },
      }),
      row({
        id: 'b',
        character: 'Juliette Nichols',
        castMemberId: 'cm-2',
        characterExternalId: 555,
        castMember: { id: 'cm-2', name: 'Rebecca Ferguson', externalId: 'TVDB_200' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
    expect(groups[0].rows).toHaveLength(2);
  });

  it('merges leading-title variants ("Daemon Targaryen" vs "Prince Daemon Targaryen") cross-provider', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Daemon Targaryen',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Matt Smith', externalId: 'TMDB_1' },
      }),
      row({
        id: 'b',
        character: 'Prince Daemon Targaryen',
        castMemberId: 'cm-2',
        characterExternalId: 7,
        castMember: { id: 'cm-2', name: 'Matt Smith', externalId: 'TVDB_2' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
  });

  it('merges quote-style variants ("Dwight \'The General\'" vs curly quotes) as identical', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: "Dwight 'The General' Manfredi",
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Sylvester Stallone', externalId: 'TMDB_1' },
      }),
      row({
        id: 'b',
        character: 'Dwight “The General” Manfredi',
        castMemberId: 'cm-2',
        characterExternalId: 7,
        castMember: { id: 'cm-2', name: 'Sylvester Stallone', externalId: 'TVDB_2' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
  });

  it('keeps same-provider similar names (may be two genuine roles, e.g. "Goku" vs "Goku Jr.")', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Goku',
        characterExternalId: 1,
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Masako Nozawa', externalId: 'TVDB_10' },
      }),
      row({
        id: 'b',
        character: 'Goku Jr.',
        characterExternalId: 2,
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Masako Nozawa', externalId: 'TVDB_10' },
      }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('keeps same-name actors playing genuinely different characters (Goku vs Gohan)', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Goku',
        castMember: { id: 'cm-1', name: 'Masako Nozawa', externalId: 'TMDB_100' },
      }),
      row({
        id: 'b',
        character: 'Gohan',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Masako Nozawa', externalId: 'TVDB_200' },
      }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('keeps cross-provider pairs whose character names merely share a word ("Red" vs "Blue Ranger")', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({
        id: 'a',
        character: 'Red Ranger',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Actor One', externalId: 'TMDB_1' },
      }),
      row({
        id: 'b',
        character: 'Blue Ranger',
        castMemberId: 'cm-2',
        characterExternalId: 9,
        castMember: { id: 'cm-2', name: 'Actor One', externalId: 'TVDB_2' },
      }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('union-find merges overlapping HIGH and MEDIUM edges into one HIGH group', () => {
    const groups = (svc as any).groupDuplicateCast([
      row({ id: 'a', characterExternalId: 42 }),
      row({
        id: 'b',
        characterExternalId: 42,
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Masako Nozawa', externalId: 'TMDB_1' },
      }),
      row({
        id: 'c',
        castMemberId: 'cm-3',
        castMember: { id: 'cm-3', name: 'Masako Nozawa', externalId: 'TVDB_2' },
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('HIGH');
    expect(groups[0].rows).toHaveLength(3);
  });
});

describe('cast dedup canonical selection', () => {
  const svc = new CastDedupService();

  it('prefers the row carrying votes', () => {
    const canonical = (svc as any).pickCanonicalCastRow([
      row({ id: 'a', sortOrder: 0 }),
      row({ id: 'b', sortOrder: 5, _count: { characterVotes: 3 } }),
    ]);
    expect(canonical.id).toBe('b');
  });

  it('prefers a real provider id over a fallback id when votes tie', () => {
    const canonical = (svc as any).pickCanonicalCastRow([
      row({
        id: 'a',
        sortOrder: 0,
        castMember: { id: 'cm-a', name: 'A', externalId: 'TMDB_900000003' },
      }),
      row({ id: 'b', sortOrder: 2, castMember: { id: 'cm-b', name: 'A', externalId: 'TVDB_555' } }),
    ]);
    expect(canonical.id).toBe('b');
  });

  it('falls back to billing order then id for full ties', () => {
    const canonical = (svc as any).pickCanonicalCastRow([
      row({ id: 'b', sortOrder: 3 }),
      row({ id: 'a', sortOrder: 1 }),
    ]);
    expect(canonical.id).toBe('a');
  });
});

describe('mergeMediaCastDuplicates', () => {
  function mockTx(rows: Row[]) {
    const calls: { sql: string }[] = [];
    const tx: any = {
      mediaItem: { findUniqueOrThrow: jest.fn().mockResolvedValue({ title: 'Dragon Ball' }) },
      mediaCast: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      castMember: { delete: jest.fn().mockResolvedValue({}) },
      mediaCastExternalId: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      __calls: calls,
    };
    return tx;
  }

  // HIGH-confidence pair: both rows carry the same TVDB characterExternalId — one
  // legacy fallback member (TMDB_900000000+i), one correctly-namespaced TVDB_ member.
  const dupRows = () => [
    row({
      id: 'a',
      sortOrder: 0,
      characterExternalId: 777,
      castMemberId: 'cm-1',
      _count: { characterVotes: 2 },
      castMember: { id: 'cm-1', name: 'A', externalId: 'TMDB_900000001' },
    }),
    row({
      id: 'b',
      sortOrder: 1,
      characterExternalId: 777,
      castMemberId: 'cm-2',
      castMember: { id: 'cm-2', name: 'A', externalId: 'TVDB_777' },
    }),
  ];

  it('repair: re-points votes before deleting the duplicate row and keeps the voted row canonical', async () => {
    const rows = dupRows();
    const tx = mockTx(rows);
    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => fn(tx)),
    };
    const svc = makeSvc(prisma);
    const out = await (svc as any).mergeMediaCastDuplicates('m1', 'repair');

    expect(out.merged).toBe(1);
    expect(out.votesMoved).toBe(1);
    // Canonical = 'a' (has votes). First raw statement moves votes; delete comes later.
    const rawCalls = tx.$executeRaw.mock.calls.map((c: any[]) => String(c[0]));
    const moveIdx = rawCalls.findIndex((s: string) => s.includes('UPDATE character_votes'));
    const delIdx = rawCalls.findIndex((s: string) => s.includes('DELETE FROM media_cast'));
    expect(moveIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(moveIdx);
    // Orphan fallback member (TMDB_900000001) deleted; canonical update happened.
    expect(tx.castMember.delete).toHaveBeenCalledWith({ where: { id: 'cm-1' } });
    expect(tx.mediaCast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a' } }),
    );
  });

  it('dry-run: returns exact counts but rolls the transaction back', async () => {
    const rows = dupRows();
    const tx = mockTx(rows);
    const prisma: any = {
      $transaction: jest.fn(async (fn: any) => {
        try {
          return await fn(tx);
        } catch (e) {
          if (e === (MetadataBackfillService as any).DRY_RUN) throw e;
          throw e;
        }
      }),
    };
    const svc = makeSvc(prisma);
    const out = await (svc as any).mergeMediaCastDuplicates('m1', 'dry-run');
    expect(out.merged).toBe(1);
    expect(out.votesMoved).toBe(1);
    // The audit stamp (repair-only write) must NOT run in dry-run.
    const rawCalls = tx.$executeRaw.mock.calls.map((c: any[]) => String(c[0]));
    expect(rawCalls.some((s: string) => s.includes('metadata_provenance'))).toBe(false);
  });

  it('report: does no writes and counts the HIGH groups it would merge', async () => {
    const rows = [
      row({ id: 'a', castMember: { id: 'cm-1', name: 'Masako Nozawa', externalId: 'TMDB_100' } }),
      row({
        id: 'b',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'masako nozawa', externalId: 'TVDB_200' },
      }),
    ];
    const tx = mockTx(rows);
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const svc = makeSvc(prisma);
    const out = await (svc as any).mergeMediaCastDuplicates('m1', 'report');
    expect(out.groupsHigh).toBe(1);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.mediaCast.update).not.toHaveBeenCalled();
  });

  it('repair: merges same-name actor + same character pairs end to end', async () => {
    const rows = [
      row({
        id: 'a',
        character: 'Matt Murdock',
        castMemberId: 'cm-1',
        _count: { characterVotes: 1 },
        castMember: { id: 'cm-1', name: 'Charlie Cox', externalId: 'TMDB_100' },
      }),
      row({
        id: 'b',
        character: 'Matt Murdock / Daredevil',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Charlie Cox', externalId: 'TVDB_200' },
      }),
    ];
    const tx = mockTx(rows);
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const svc = makeSvc(prisma);
    const out = await (svc as any).mergeMediaCastDuplicates('m1', 'repair');
    expect(out.merged).toBe(1);
    expect(out.votesMoved).toBe(1);
    // Canonical = the vote-carrying row 'a'; its localized/character data is retained.
    expect(tx.mediaCast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a' } }),
    );
  });

  it('mergeCastPair: merges a reviewed name-only pair with the forced canonical row', async () => {
    const rows = [
      row({
        id: 'keep',
        character: 'Matt Murdock',
        castMemberId: 'cm-1',
        _count: { characterVotes: 0 },
        castMember: { id: 'cm-1', name: 'Charlie Cox', externalId: 'TMDB_100' },
      }),
      row({
        id: 'dup',
        character: 'Matt Murdock / Daredevil',
        castMemberId: 'cm-2',
        _count: { characterVotes: 4 },
        castMember: { id: 'cm-2', name: 'Charlie Cox', externalId: 'TVDB_200' },
      }),
    ];
    const tx = mockTx(rows);
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const svc = makeSvc(prisma);
    const out = await svc.mergeCastPair('m1', 'keep', 'dup');

    expect(out.merged).toBe(1);
    expect(out.votesMoved).toBe(1); // $executeRaw mock returns 1
    // Votes re-pointed to the FORCED canonical row (not the vote-carrying dup).
    const voteMove = tx.$executeRaw.mock.calls
      .map((c: any[]) => ({ sql: String(c[0]), params: c.slice(1) }))
      .find((c: any) => c.sql.includes('UPDATE character_votes'));
    expect(voteMove).toBeDefined();
    expect(JSON.stringify(voteMove.params)).toContain('keep');
    // Canonical update targets the kept row; dup row deleted via raw SQL.
    expect(tx.mediaCast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'keep' } }),
    );
  });

  it('mergeCastPair: rejects when the rows are not both found on the media', async () => {
    const tx = mockTx([
      row({
        id: 'keep',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'A', externalId: 'TMDB_1' },
      }),
    ]);
    const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
    const svc = makeSvc(prisma);
    await expect(svc.mergeCastPair('m1', 'keep', 'missing')).rejects.toThrow(
      'Expected 2 cast rows',
    );
  });
});

describe('CastDedupService.mergeInline (hydration self-heal)', () => {
  const svc = new CastDedupService();

  function mockTx(rows: any[]) {
    return {
      mediaCast: {
        findMany: jest.fn().mockResolvedValue(rows),
        update: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
      mediaItem: { findUnique: jest.fn().mockResolvedValue({ title: 'Show' }) },
      castMember: { delete: jest.fn().mockResolvedValue({}) },
      mediaCastExternalId: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as any;
  }

  it('merges HIGH groups inside the open transaction', async () => {
    const tx = mockTx([
      row({
        id: 'a',
        character: 'Matt Murdock',
        castMemberId: 'cm-1',
        _count: { characterVotes: 2 },
        castMember: { id: 'cm-1', name: 'Charlie Cox', externalId: 'TMDB_475230' },
      }),
      row({
        id: 'b',
        character: 'Matt Murdock / Daredevil',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Charlie Cox', externalId: 'TMDB_475230' },
      }),
    ]);
    const out = await svc.mergeInline(tx, 'm1');
    expect(out.merged).toBe(1);
    expect(out.votesMoved).toBe(1);
    expect(tx.mediaCast.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'a' } }), // vote-carrying row survives
    );
  });

  it('is a no-op (and skips the title lookup) when there are no duplicates', async () => {
    const tx = mockTx([
      row({
        id: 'a',
        character: 'Goku',
        castMemberId: 'cm-1',
        castMember: { id: 'cm-1', name: 'Masako Nozawa', externalId: 'TMDB_100' },
      }),
      row({
        id: 'b',
        character: 'Vegeta',
        castMemberId: 'cm-2',
        castMember: { id: 'cm-2', name: 'Ryo Horikawa', externalId: 'TMDB_101' },
      }),
    ]);
    const out = await svc.mergeInline(tx, 'm1');
    expect(out).toEqual({ merged: 0, votesMoved: 0 });
    expect(tx.mediaItem.findUnique).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
