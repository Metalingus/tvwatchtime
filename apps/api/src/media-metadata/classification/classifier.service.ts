import { Injectable } from '@nestjs/common';
import type { CandidateResult, ClassificationResult, ProviderMatchResult } from './types';

/**
 * Final content classification (Phase 7). Runs AFTER provider matching (Phase 6) and
 * candidate detection (Phase 4). Non-circular: classification never precedes matching.
 *
 *   reliable Kitsu/MAL anime match            → ANIME, confirmed, high
 *   no match + animation + Japanese evidence  → ANIME, probable, medium
 *   animation alone (or weak candidate)       → GENERAL, candidate tier
 *   no candidate                              → GENERAL
 *
 * Manga is never auto-emitted from SHOW/MOVIE metadata: in the classification-only
 * scope, manga publications are not stored as media rows, and adaptations must not be
 * classified as manga. (Publication-specific manga matching is handled internally.)
 */
@Injectable()
export class ClassifierService {
  classify(candidate: CandidateResult, match: ProviderMatchResult | null | undefined): ClassificationResult {
    // Reliable provider match (Kitsu, then Jikan) → confirmed anime.
    if (match && match.matched) {
      return {
        classification: 'ANIME',
        tier: 'confirmed',
        confidence: Math.max(0.6, Math.min(0.99, match.confidence ?? 0.9)),
        evidence: { ...(candidate.evidence ?? {}), matchProvider: match.provider, matchId: match.externalId },
      };
    }

    // Non-candidate: nothing triggered anime matching.
    if (!candidate.isCandidate) {
      return { classification: 'GENERAL', tier: 'confirmed', confidence: 0, evidence: candidate.evidence ?? {} };
    }

    const ev = candidate.evidence ?? {};
    const hasAnimation = ev.hasAnimation === true || candidate.signals.includes('animation_genre');
    const ja = ev.japaneseLanguage === true;
    const jp = ev.japaneseOrigin === true;
    const studio = ev.animeStudio === true;
    const tvdbAnime = ev.tvdbAnimeSignal === true;
    const agreeing = [ja, jp, studio, tvdbAnime].filter(Boolean).length;

    // Probable: a verified anime id, OR animation + at least one strong agreeing signal.
    const strong =
      candidate.hasVerifiedAnimeId || (hasAnimation && (ja || jp || studio || tvdbAnime));
    if (strong) {
      const conf = Math.min(0.7, 0.45 + agreeing * 0.08 + (candidate.hasVerifiedAnimeId ? 0.15 : 0));
      return {
        classification: 'ANIME',
        tier: 'probable',
        confidence: Number(conf.toFixed(2)),
        evidence: { ...ev, fallbackReason: match?.reason ?? 'no_match', agreeing },
      };
    }

    // Candidate with only a weak signal (e.g. animation alone, Western animation):
    // remains GENERAL at candidate tier until stronger evidence arrives.
    return {
      classification: 'GENERAL',
      tier: 'candidate',
      confidence: 0.15,
      evidence: { ...ev, weak: true, reason: match?.reason ?? 'no_match' },
    };
  }
}
