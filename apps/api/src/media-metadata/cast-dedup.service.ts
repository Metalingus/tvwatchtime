import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** A media_cast row with everything the dedup logic needs. */
export interface CastDupRow {
  id: string;
  castMemberId: string;
  character: string | null;
  characterImageUrl?: string | null;
  characterExternalId: number | null;
  sortOrder: number;
  characters: unknown;
  castMember: { id: string; name: string; externalId: string | null };
  _count: { characterVotes: number };
}

export interface CastMergeOutcome {
  merged: number;
  rowsDeleted: number;
  votesMoved: number;
  votesConflictResolved: number;
  orphanMembersDeleted: number;
}

const CAST_DUP_INCLUDE = {
  castMember: { select: { id: true, name: true, externalId: true } },
  _count: { select: { characterVotes: true } },
} satisfies Prisma.MediaCastInclude;

/**
 * Cast deduplication core, shared by the batch repair (MetadataBackfillService) and
 * the hydration path (MediaMetadataService calls mergeInline at the end of every
 * cast sync, so a hydration that would otherwise LEAVE a duplicate heals it inside
 * the same transaction — character-id backfills and TVDB rehydrations included).
 */
@Injectable()
export class CastDedupService {
  private readonly logger = new Logger(CastDedupService.name);

  /**
   * Inline merge for the hydration transaction: find HIGH-confidence duplicate groups
   * on this media and merge them immediately. Cheap: one ≤40-row read plus in-memory
   * grouping; writes only when duplicates actually exist.
   */
  async mergeInline(
    tx: Prisma.TransactionClient,
    mediaId: string,
  ): Promise<{ merged: number; votesMoved: number }> {
    const rows = await tx.mediaCast.findMany({
      where: { mediaId },
      include: CAST_DUP_INCLUDE,
      orderBy: { sortOrder: 'asc' },
    });
    const groups = this.groupDuplicateCast(rows).filter((g) => g.confidence === 'HIGH');
    if (!groups.length) return { merged: 0, votesMoved: 0 };
    const title =
      (await tx.mediaItem.findUnique({ where: { id: mediaId }, select: { title: true } }))?.title ??
      mediaId;
    let merged = 0;
    let votesMoved = 0;
    for (const g of groups) {
      const r = await this.mergeCastGroupTx(tx, mediaId, title, g.rows);
      merged += r.merged;
      votesMoved += r.votesMoved;
    }
    if (merged) {
      this.logger.log(
        `hydration inline cast-dedup ${mediaId} (${title}): merged ${merged} group(s), ${votesMoved} vote(s) moved`,
      );
    }
    return { merged, votesMoved };
  }

  /**
   * Union-find grouping of a media's cast rows into duplicate clusters.
   *
   * HIGH (auto-merged):
   *  - same cast_member record, or same TVDB characterExternalId;
   *  - same normalized person name + same normalized character name. Within ONE media
   *    this is a safe merge: two different actors with the same name playing the same
   *    character on the same title is effectively impossible, and the rows exist only
   *    because providers issued different person ids;
   *  - same normalized person name + prefix-compatible character ("Matt Murdock" vs
   *    "Matt Murdock / Daredevil" — providers format dual-role names differently);
   *  - cross-provider SIMILAR names (word-boundary containment, e.g. "Juliette" vs
   *    "Juliette Nichols") — but only when the rows come from different providers.
   * Rows are only grouped when the normalized person name is non-empty.
   * Genuinely different characters never group (one actor, two roles stays untouched).
   */
  groupDuplicateCast(rows: CastDupRow[]): { confidence: 'HIGH' | 'MEDIUM'; rows: CastDupRow[] }[] {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(x, r);
      return r;
    };
    const union = (a: string, b: string) => parent.set(find(a), find(b));
    for (const r of rows) parent.set(r.id, r.id);
    const highKeys = new Map<string, string[]>();
    const norm = (s: string) =>
      s
        .toLowerCase()
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        // Quote-style differences ("Dwight 'The General'" vs "Dwight “The General”")
        // must not block an otherwise-identical name.
        .replace(/[‘’‚‛“”„‟"']/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    for (const r of rows) {
      const normName = norm(r.castMember.name);
      const normChar = norm(r.character ?? '');
      const keys = [`member:${r.castMemberId}`];
      if (r.characterExternalId != null) keys.push(`charExt:${r.characterExternalId}`);
      if (normName) {
        keys.push(`name:${normName}|${normChar}`);
        // Prefix variant ("Matt Murdock" vs "Matt Murdock / Daredevil"): BOTH rows
        // emit the base-segment key so the pair groups as HIGH.
        const charBase = normChar.split('/')[0].trim();
        if (charBase) keys.push(`namebase:${normName}|${charBase}`);
      }
      for (const key of keys) {
        const arr = highKeys.get(key) ?? [];
        arr.push(r.id);
        highKeys.set(key, arr);
      }
    }
    const highEdge = new Set<string>();
    for (const ids of highKeys.values()) {
      if (ids.length < 2) continue;
      for (let k = 1; k < ids.length; k++) {
        union(ids[0], ids[k]);
        highEdge.add(ids[0]);
        highEdge.add(ids[k]);
      }
    }
    // Cross-provider SIMILAR names: same actor, character names where one contains
    // the other at a word boundary ("Juliette" vs "Juliette Nichols", "Daemon
    // Targaryen" vs "Prince Daemon Targaryen" — TMDB often shortens / TVDB uses the
    // full or titled name). Merged only when the two rows come from DIFFERENT
    // providers; same-provider near-duplicates may be two genuine roles (one actor
    // voicing "Goku" and "Goku Jr.") and are kept.
    const tvdbish = (r: CastDupRow) =>
      (r.castMember.externalId ?? '').startsWith('TVDB_') || r.characterExternalId != null;
    const similar = (a: string, b: string) =>
      a.length > 0 &&
      b.length > 0 &&
      a !== b &&
      (a.startsWith(b + ' ') ||
        b.startsWith(a + ' ') ||
        a.endsWith(' ' + b) ||
        b.endsWith(' ' + a));
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i];
        const b = rows[j];
        if (norm(a.castMember.name) !== norm(b.castMember.name)) continue;
        if (!similar(norm(a.character ?? ''), norm(b.character ?? ''))) continue;
        if (tvdbish(a) === tvdbish(b)) continue;
        union(a.id, b.id);
        highEdge.add(a.id);
        highEdge.add(b.id);
      }
    }
    const byRoot = new Map<string, CastDupRow[]>();
    for (const r of rows) {
      const root = find(r.id);
      const arr = byRoot.get(root) ?? [];
      arr.push(r);
      byRoot.set(root, arr);
    }
    const groups: { confidence: 'HIGH' | 'MEDIUM'; rows: CastDupRow[] }[] = [];
    for (const members of byRoot.values()) {
      if (members.length < 2) continue;
      const confidence = members.some((m) => highEdge.has(m.id)) ? 'HIGH' : 'MEDIUM';
      groups.push({ confidence, rows: members });
    }
    return groups;
  }

  /** Canonical survivor of a duplicate group: votes first (never lose votes), then a
   *  real provider-namespaced member id, then a TVDB character id, then billing. */
  pickCanonicalCastRow<
    T extends {
      id: string;
      castMemberId: string;
      characterExternalId: number | null;
      sortOrder: number;
      castMember: { externalId: string | null };
      _count: { characterVotes: number };
    },
  >(rows: T[]): T {
    const realId = (r: T) => {
      const ext = r.castMember.externalId ?? '';
      // Real provider id (TMDB_/TVDB_ + digits) but NOT the legacy index-based
      // fallback range (TMDB_900000000+i).
      return /^(TMDB|TVDB)_\d+$/.test(ext) && !/^TMDB_9\d{8}$/.test(ext) ? 1 : 0;
    };
    return [...rows].sort(
      (a, b) =>
        b._count.characterVotes - a._count.characterVotes ||
        realId(b) - realId(a) ||
        (b.characterExternalId != null ? 1 : 0) - (a.characterExternalId != null ? 1 : 0) ||
        a.sortOrder - b.sortOrder ||
        a.id.localeCompare(b.id),
    )[0];
  }

  /**
   * Merge one duplicate group inside an open transaction. Canonical survivor: the
   * forced id when given (manual merge), else pickCanonicalCastRow. Votes are
   * re-pointed BEFORE the duplicate rows are deleted; duplicates are deleted only
   * once vote-free; fallback cast members orphaned by the merge are removed.
   */
  async mergeCastGroupTx(
    tx: Prisma.TransactionClient,
    mediaId: string,
    title: string,
    rows: CastDupRow[],
    forcedCanonicalId?: string,
  ): Promise<CastMergeOutcome> {
    const out: CastMergeOutcome = {
      merged: 0,
      rowsDeleted: 0,
      votesMoved: 0,
      votesConflictResolved: 0,
      orphanMembersDeleted: 0,
    };
    const canonical = forcedCanonicalId
      ? rows.find((r) => r.id === forcedCanonicalId)!
      : this.pickCanonicalCastRow(rows);
    const dups = rows.filter((r) => r.id !== canonical.id);
    if (!dups.length) return out;
    const dupIds = dups.map((r) => r.id);
    // 1) Move provider role aliases before deleting duplicate credits. Aliases are
    // title-scoped and therefore remain valid on the canonical row.
    await tx.mediaCastExternalId.updateMany({
      where: { castId: { in: dupIds } },
      data: { castId: canonical.id },
    });

    // 2) Re-point episode and movie votes to the canonical row, guarded against a
    // same-user/same-target uniqueness collision.
    const moved = await tx.$executeRaw`
      UPDATE character_votes cv SET cast_id = ${canonical.id}
      WHERE cv.cast_id IN (${Prisma.join(dupIds)})
        AND NOT EXISTS (
          SELECT 1 FROM character_votes x
          WHERE x.user_id = cv.user_id
            AND (
              (x.episode_id IS NOT NULL AND x.episode_id = cv.episode_id)
              OR (x.media_id IS NOT NULL AND x.media_id = cv.media_id)
            )
            AND x.cast_id = ${canonical.id}
        )`;
    out.votesMoved += moved;
    // 3) Pathological leftovers (user somehow voted both rows for the SAME target —
    //    impossible via the API, possible via a past import race): the canonical row's
    //    vote wins; log the discarded duplicate vote ids.
    const conflicts = await tx.$queryRaw<{ id: string }[]>`
      SELECT cv.id FROM character_votes cv
      WHERE cv.cast_id IN (${Prisma.join(dupIds)})
        AND EXISTS (
          SELECT 1 FROM character_votes x
          WHERE x.user_id = cv.user_id
            AND (
              (x.episode_id IS NOT NULL AND x.episode_id = cv.episode_id)
              OR (x.media_id IS NOT NULL AND x.media_id = cv.media_id)
            )
            AND x.cast_id = ${canonical.id}
        )`;
    if (conflicts.length) {
      this.logger.warn(
        `cast-dedup ${mediaId}: discarding ${conflicts.length} duplicate same-episode vote(s) ` +
          `(kept canonical row ${canonical.id}): ${conflicts.map((c) => c.id).join(', ')}`,
      );
      await tx.$executeRaw`
        DELETE FROM character_votes WHERE id IN (${Prisma.join(conflicts.map((c) => c.id))})`;
      out.votesConflictResolved += conflicts.length;
    }
    // 4) Delete duplicates only once zero votes reference them. This runs BEFORE the
    //    canonical update below so a member repoint can never transiently violate the
    //    (mediaId, castMemberId) unique index.
    const deleted = await tx.$executeRaw`
      DELETE FROM media_cast mc WHERE mc.id IN (${Prisma.join(dupIds)})
        AND NOT EXISTS (SELECT 1 FROM character_votes cv WHERE cv.cast_id = mc.id)`;
    out.rowsDeleted += deleted;
    out.merged += deleted > 0 ? 1 : 0;
    // 5) Merge localized character-name overrides into the canonical row, and repoint
    //    it to the group's REAL provider-namespaced cast member when the canonical row
    //    sits on a legacy fallback member (TMDB_900000000+i / TVDB_<id>_(CHAR|NAME)_).
    const isFallbackExt = (ext: string | null) =>
      /^TMDB_9\d{8}$/.test(ext ?? '') || /^TVDB_\d+_(CHAR|NAME)_/.test(ext ?? '');
    const realMember = [canonical, ...dups].find((r) => !isFallbackExt(r.castMember.externalId));
    const repointMember =
      realMember && realMember.castMemberId !== canonical.castMemberId
        ? realMember.castMemberId
        : undefined;
    const mergedChars: Record<string, string> = {};
    for (const r of [...dups, canonical]) {
      const c = r.characters;
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        Object.assign(mergedChars, c as Record<string, string>);
      }
    }
    await tx.mediaCast.update({
      where: { id: canonical.id },
      data: {
        ...(repointMember ? { castMemberId: repointMember } : {}),
        characters: Object.keys(mergedChars).length ? mergedChars : undefined,
        character: canonical.character ?? dups.find((d) => d.character)?.character ?? null,
        characterExternalId:
          canonical.characterExternalId ??
          dups.find((d) => d.characterExternalId != null)?.characterExternalId ??
          null,
        characterImageUrl:
          canonical.characterImageUrl ??
          dups.find((d) => d.characterImageUrl)?.characterImageUrl ??
          null,
        sortOrder: Math.min(canonical.sortOrder, ...dups.map((d) => d.sortOrder)),
      },
    });
    // 6) Remove orphan FALLBACK cast members left with no credits at all — including
    //    the canonical row's original member after a repoint. Real provider-id members
    //    are global records and are kept.
    const memberIdsToCheck = new Set(dups.map((r) => r.castMemberId));
    if (repointMember) memberIdsToCheck.add(canonical.castMemberId);
    for (const memberId of memberIdsToCheck) {
      const memberRow =
        dups.find((r) => r.castMemberId === memberId)?.castMember ??
        (memberId === canonical.castMemberId ? canonical.castMember : null);
      if (!memberRow || !isFallbackExt(memberRow.externalId)) continue;
      const remaining = await tx.mediaCast.count({ where: { castMemberId: memberId } });
      if (remaining === 0) {
        await tx.castMember.delete({ where: { id: memberId } }).catch(() => undefined);
        out.orphanMembersDeleted++;
      }
    }
    this.logger.log(
      `cast-dedup ${mediaId} (${title}): merged ${dupIds.length} row(s) into ${canonical.id} ` +
        `(member ${canonical.castMember.externalId ?? canonical.castMemberId}); ` +
        `votes moved=${moved}, conflicts=${conflicts.length}, rows deleted=${deleted}`,
    );
    return out;
  }
}
