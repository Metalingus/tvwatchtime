export type TvdbGenreSignal =
  | string
  | {
      id?: number | null;
      tmdbId?: number | null;
      name?: string | null;
      slug?: string | null;
    };

/**
 * TVDB's explicit Anime genre is authoritative routing evidence for a brand-new
 * TVDB series. This is intentionally separate from the strict TMDB classifier:
 * callers must apply it only while creating a previously unknown TVDB show.
 */
export function hasExplicitTvdbAnimeGenre(
  genres: readonly TvdbGenreSignal[] | null | undefined,
): boolean {
  return (genres ?? []).some((genre) => {
    if (typeof genre === 'string') return genre.trim().toLowerCase() === 'anime';
    const id = genre.id ?? genre.tmdbId;
    return (
      id === 27 ||
      genre.name?.trim().toLowerCase() === 'anime' ||
      genre.slug?.trim().toLowerCase() === 'anime'
    );
  });
}
