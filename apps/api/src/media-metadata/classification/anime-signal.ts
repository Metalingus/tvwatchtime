/**
 * Match-time anime signal from TMDB metadata (used by the import matcher before any
 * hydration/classification has happened). TMDB genre id 16 = Animation; the JP origin
 * requirement keeps Western animation (The Simpsons, Pixar) TMDB-first, consistent with
 * the classifier's animation + JP-evidence rule. TVDB stays authoritative only for anime:
 * TMDB anime season/episode structures are frequently wrong.
 */
export function isAnimeSignal(genreIds: number[], originCountries: string[]): boolean {
  return genreIds.includes(16) && originCountries.includes('JP');
}
