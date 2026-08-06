// TV Time character-vote import: detection, normalization, and dedup for
// `show_character_episode_vote.csv` (favorite-character-per-episode votes).
//
// Column semantics (header-keyed; the three export layouts differ in ORDER only):
//   tv_show_name            show title (match input)
//   episode_id              TVDB EPISODE id — resolves locally via episode_external_ids
//   episode_season_number   S fallback for episode resolution
//   episode_number          E fallback for episode resolution
//   show_character_id       TVDB CHARACTER id — resolves locally via media_cast.characterExternalId
//   created_at/updated_at   vote timestamps (latest wins on duplicate rows)
//
// Everything resolves locally at apply time — NO provider calls per vote (see
// applyCharacterVotes in import.service.ts).

import { parseDate } from './inference';

export interface NormalizedCharacterVote {
  sourceRow: number;
  showTitle: string | null;
  seasonNumber: number | null;
  episodeNumber: number | null;
  /** TVDB episode id (externalEpisodeId for episode resolution). */
  externalEpisodeId: number;
  /** TVDB character id (resolves to media_cast.characterExternalId at apply time). */
  showCharacterId: number;
  /** Stable source/audit identity for the selected character. */
  voteKey: string;
  sourceCreatedAt: Date | null;
  sourceUpdatedAt: Date | null;
}

export interface CharacterVoteFileResult {
  candidates: NormalizedCharacterVote[];
  detected: number;
  invalid: number;
}

/** Classify by filename (basename prefix); column mapping itself is header-keyed. */
export function detectCharacterVoteFile(filename: string): boolean {
  const f = (filename.replace(/\\/g, '/').split('/').pop() ?? filename).toLowerCase();
  return f.startsWith('show_character_episode_vote');
}

const pick = (row: Record<string, string>, keys: string[]): string | undefined => {
  for (const k of Object.keys(row)) {
    if (keys.includes(k.toLowerCase().trim())) {
      const v = row[k];
      const s = v == null ? undefined : String(v).trim();
      return !s || s === '<nil>' ? undefined : s;
    }
  }
  return undefined;
};

const toInt = (v: string | undefined): number | null => {
  if (v == null) return null;
  const digits = String(v).replace(/[^\d-]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
};

const toDate = (v: string | undefined): Date | null => parseDate(v);

/**
 * Normalize every row into character-vote candidates. Rows missing the TVDB episode id
 * or the character id are invalid (counted, never thrown).
 */
export function normalizeCharacterVotes(
  filename: string,
  rows: Record<string, string>[],
): CharacterVoteFileResult {
  const candidates: NormalizedCharacterVote[] = [];
  let detected = 0;
  let invalid = 0;
  if (!detectCharacterVoteFile(filename)) return { candidates, detected, invalid };

  rows.forEach((row, idx) => {
    detected++;
    const externalEpisodeId = toInt(pick(row, ['episode_id']));
    const showCharacterId = toInt(pick(row, ['show_character_id']));
    if (externalEpisodeId == null || showCharacterId == null) {
      invalid++;
      return;
    }
    candidates.push({
      sourceRow: idx + 1,
      showTitle: pick(row, ['tv_show_name', 'show_name', 'name']) ?? null,
      seasonNumber: toInt(pick(row, ['episode_season_number', 'season_number', 'season'])),
      episodeNumber: toInt(pick(row, ['episode_number', 'episode'])),
      externalEpisodeId,
      showCharacterId,
      voteKey: `episode:${externalEpisodeId}:char:${showCharacterId}`,
      sourceCreatedAt: toDate(pick(row, ['created_at'])),
      sourceUpdatedAt: toDate(pick(row, ['updated_at'])),
    });
  });
  return { candidates, detected, invalid };
}

/**
 * TV Time can retain historical character selections for one source episode. A user has
 * exactly one active favorite, so keep only the latest row for each source episode rather
 * than importing every character they selected over time.
 */
export function dedupeCharacterVotes(
  candidates: NormalizedCharacterVote[],
): NormalizedCharacterVote[] {
  const byKey = new Map<string, NormalizedCharacterVote>();
  for (const c of candidates) {
    const targetKey = `episode:${c.externalEpisodeId}`;
    const prev = byKey.get(targetKey);
    if (!prev) {
      byKey.set(targetKey, c);
      continue;
    }
    const prevTs = prev.sourceUpdatedAt?.getTime() ?? prev.sourceCreatedAt?.getTime() ?? 0;
    const curTs = c.sourceUpdatedAt?.getTime() ?? c.sourceCreatedAt?.getTime() ?? 0;
    if (curTs >= prevTs) byKey.set(targetKey, c);
  }
  return [...byKey.values()];
}
