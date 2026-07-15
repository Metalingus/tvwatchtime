import { Injectable } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import type { CandidateInput, CandidateResult } from './types';

const ANIMATION_GENRE = /^animation$/;
/** Recognized Japanese animation studios (lowercased substring match). */
const ANIME_STUDIOS = [
  'toei animation',
  'madhouse',
  'bones',
  'wit studio',
  'mappa',
  'kyoto animation',
  'a-1 pictures',
  'studio ghibli',
  'sunrise',
  'production i.g',
  'production ig',
  'shaft',
  'ufotable',
  'trigger',
  'cloverworks',
  'jc staff',
  'deen',
  'silver link',
  'tms entertainment',
];

function hasVerifiedAnimeId(ids: { provider: ExternalProvider; providerEntityKind: ProviderEntityKind }[] = []): boolean {
  return ids.some(
    (i) =>
      (i.provider === ExternalProvider.KITSU && i.providerEntityKind === ProviderEntityKind.ANIME) ||
      (i.provider === ExternalProvider.MYANIME_LIST && i.providerEntityKind === ProviderEntityKind.ANIME),
  );
}

/**
 * Detect anime candidates from available metadata — provider-call-free and DB-row-free
 * (works identically on a hydrated row or a cached provisional snapshot). Produces a
 * candidate flag + supporting evidence; it NEVER sets final ANIME classification.
 *
 * Candidate triggers (any one suffices): manual flag, a verified Kitsu/MAL anime id,
 * an `animation` genre (TMDB/TVDB), or a strong TVDB anime type signal. Japanese
 * origin/language/studios are SUPPORTING evidence only (they raise confidence later),
 * never a trigger by themselves.
 */
@Injectable()
export class CandidateDetectorService {
  detect(input: CandidateInput): CandidateResult {
    const signals: string[] = [];
    const evidence: Record<string, unknown> = {};

    const genresLower = (input.genres ?? []).map((g) => g.toLowerCase());
    const hasAnimation = genresLower.some((g) => ANIMATION_GENRE.test(g));

    if (input.manualCandidate) signals.push('manual_candidate');
    const verifiedAnime = hasVerifiedAnimeId(input.externalIds);
    if (verifiedAnime) signals.push('verified_anime_id');
    if (hasAnimation) signals.push('animation_genre');
    const tvdbAnime =
      !!input.tvdbType && /anime/i.test(input.tvdbType);
    if (tvdbAnime) signals.push('tvdb_anime_signal');

    // Supporting evidence (not triggers)
    const jaLang = !!input.originalLanguage && input.originalLanguage.toLowerCase() === 'ja';
    const jpOrigin = (input.originCountries ?? []).some((c) => c?.toUpperCase() === 'JP');
    const jpStudio = (input.studios ?? []).some((s) =>
      ANIME_STUDIOS.some((a) => (s ?? '').toLowerCase().includes(a)),
    );
    if (jaLang) evidence.japaneseLanguage = true;
    if (jpOrigin) evidence.japaneseOrigin = true;
    if (jpStudio) evidence.animeStudio = true;
    if (hasAnimation) evidence.hasAnimation = true;
    if (tvdbAnime) evidence.tvdbAnimeSignal = true;

    return {
      isCandidate: signals.length > 0,
      signals,
      hasVerifiedAnimeId: verifiedAnime,
      evidence,
    };
  }
}
