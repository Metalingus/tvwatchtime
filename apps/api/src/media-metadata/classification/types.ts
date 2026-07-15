import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';

/** A verified namespace-aware external identity reference. */
export interface IdentityRef {
  provider: ExternalProvider;
  providerEntityKind: ProviderEntityKind;
  value: string;
}

/** Inputs available for candidate detection — from a hydrated row OR a cached provisional snapshot. */
export interface CandidateInput {
  /** Normalized lowercased genre names (union across providers, e.g. 'animation'). */
  genres?: string[];
  originalLanguage?: string | null;
  originCountries?: string[];
  studios?: string[];
  externalIds?: IdentityRef[];
  manualCandidate?: boolean;
  /** TVDB type/genre hints, e.g. an anime-type designation. */
  tvdbType?: string | null;
  /** Structural media type (only used to record evidence, never as proof). */
  structuralType?: 'SHOW' | 'MOVIE' | string;
}

export interface CandidateResult {
  /** Eligible for Kitsu/Jikan anime matching. Never equals final ANIME classification. */
  isCandidate: boolean;
  signals: string[];
  hasVerifiedAnimeId: boolean;
  evidence: Record<string, unknown>;
}

export type ClassificationTier = 'candidate' | 'probable' | 'confirmed' | 'unknown';

export interface ClassificationResult {
  classification: 'GENERAL' | 'ANIME' | 'MANGA' | 'UNKNOWN';
  tier: ClassificationTier;
  confidence: number; // 0..1
  evidence: Record<string, unknown>;
}

/** Result of provider matching for one candidate (Phase 6 produces this). */
export interface ProviderMatchResult {
  matched: boolean;
  reason?: 'no_result' | 'provider_unavailable' | 'empty_catalogue';
  provider?: ExternalProvider;
  providerEntityKind?: ProviderEntityKind;
  externalId?: string;
  confidence?: number;
  evidence?: Record<string, unknown>;
}
