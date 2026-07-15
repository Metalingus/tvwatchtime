import { Injectable } from '@nestjs/common';
import { ExternalProvider } from '@tvwatch/shared';
import type { NormalizedAnime } from '../providers/normalized-anime';
import { KitsuProvider } from '../providers/kitsu.provider';
import { JikanProvider } from '../providers/jikan.provider';
import type { ProviderMatchResult } from '../classification/types';
import { ProviderError } from '../providers/shared/provider-errors';

export interface MatchInput {
  title: string;
  alternativeTitles?: string[];
  year?: number | null;
  /** Structural media type of the local/origin item. */
  structuralType?: 'SHOW' | 'MOVIE' | string;
  episodeCount?: number | null;
}

/** Match-acceptance threshold; below it the result is review, not a merge. */
export const MATCH_THRESHOLD = 0.7;

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .trim();
}

function titleScore(input: MatchInput, cand: NormalizedAnime): number {
  const it = norm(input.title);
  const candTitles = [cand.title, cand.canonicalTitle, ...(cand.alternativeTitles ?? [])]
    .filter((s): s is string => !!s)
    .map(norm);
  if (candTitles.includes(it)) return 1;
  for (const c of candTitles) {
    if (c && it && (c === it || c.includes(it) || it.includes(c))) return 0.65;
  }
  return 0;
}

function yearScore(input: MatchInput, cand: NormalizedAnime): number {
  if (!input.year) return 0.5;
  const candYear = cand.startDate ? Number(cand.startDate.slice(0, 4)) : NaN;
  if (!Number.isFinite(candYear)) return 0.5;
  const d = Math.abs(candYear - input.year);
  if (d === 0) return 1;
  if (d === 1) return 0.9;
  if (d <= 3) return 0.6;
  if (d <= 6) return 0.3;
  return 0;
}

function subtypeScore(input: MatchInput, cand: NormalizedAnime): { score: number; mismatch: boolean } {
  const sub = (cand.subtype ?? '').toUpperCase();
  if (!sub) return { score: 0.5, mismatch: false };
  const inputMovie = input.structuralType === 'MOVIE';
  const candMovie = sub === 'MOVIE';
  const mismatch = inputMovie !== candMovie; // series vs movie disagreement
  if (!mismatch) return { score: 1, mismatch: false };
  return { score: 0.1, mismatch: true }; // recap/compilation/series-vs-movie: strong demerit
}

function episodeScore(input: MatchInput, cand: NormalizedAnime): number {
  if (!input.episodeCount || !cand.episodeCount) return 0.5;
  const d = Math.abs(input.episodeCount - cand.episodeCount);
  if (d === 0) return 1;
  if (d <= 2) return 0.8;
  if (d <= Math.max(3, input.episodeCount * 0.1)) return 0.6;
  return 0.2;
}

/** Pure scoring of a single candidate against the input. 0..1. */
export function scoreAnimeCandidate(input: MatchInput, cand: NormalizedAnime): number {
  const t = titleScore(input, cand);
  if (t === 0) return 0; // no title similarity → never auto-merge (guards same-title unrelated works)
  const y = yearScore(input, cand);
  // A known year more than 6 years off almost always means a different work
  // (remake / sequel / adaptation / unrelated). Reject to force review.
  if (y === 0) return 0;
  const { score: s, mismatch } = subtypeScore(input, cand);
  const e = episodeScore(input, cand);
  let composite = t * 0.6 + y * 0.2 + s * 0.1 + e * 0.1;
  // A series-vs-movie mismatch (recap/compilation film vs series) must go to review,
  // not auto-merge — halve the score so it falls below the acceptance threshold.
  if (mismatch) composite *= 0.5;
  return Number(composite.toFixed(3));
}

/**
 * Anime matching (Phase 6). Candidate-driven: search Kitsu first; if no reliable
 * match, fall back to Jikan/MyAnimeList. Returns a typed result that distinguishes
 * a genuine no-match from provider unavailability. Runs against a provider identity
 * or a hydrated row equally (the caller supplies normalized input).
 */
@Injectable()
export class AnimeMatchService {
  constructor(
    private readonly kitsu: KitsuProvider,
    private readonly jikan: JikanProvider,
  ) {}

  async matchAnime(input: MatchInput): Promise<ProviderMatchResult> {
    // 1) Kitsu (preferred)
    try {
      const res = await this.bestFrom(input, await this.kitsu.searchAnime(input.title), ExternalProvider.KITSU, 'kitsuId');
      if (res) return res;
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      // provider unavailable → fall through to Jikan; remember the reason if Jikan also fails
    }
    // 2) Jikan / MyAnimeList (fallback). Identity stored as MYANIME_LIST.
    try {
      const res = await this.bestFrom(input, await this.jikan.searchAnime(input.title), ExternalProvider.MYANIME_LIST, 'malId');
      if (res) return res;
      return { matched: false, reason: 'no_result' };
    } catch (e) {
      if (e instanceof ProviderError) return { matched: false, reason: 'provider_unavailable' };
      throw e;
    }
  }

  private bestFrom(
    input: MatchInput,
    candidates: NormalizedAnime[],
    provider: ExternalProvider,
    idField: 'kitsuId' | 'malId',
  ): ProviderMatchResult | null {
    let best: { cand: NormalizedAnime; score: number } | null = null;
    for (const cand of candidates) {
      const score = scoreAnimeCandidate(input, cand);
      if (score > (best?.score ?? -1)) best = { cand, score };
    }
    if (best && best.score >= MATCH_THRESHOLD) {
      return {
        matched: true,
        provider,
        externalId: String((best.cand as any)[idField] ?? ''),
        confidence: best.score,
        evidence: { title: best.cand.title, subtype: best.cand.subtype, year: best.cand.startDate },
      };
    }
    return null;
  }
}
