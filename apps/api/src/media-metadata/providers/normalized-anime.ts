/** Provider-neutral anime/manga metadata (Kitsu + Jikan/MyAnimeList normalize into this). */
export interface NormalizedAnime {
  providerEntityKind: 'ANIME';
  kitsuId?: string;
  malId?: string;
  title: string;
  canonicalTitle?: string | null;
  alternativeTitles?: string[];
  synopsis?: string | null;
  posterUrl?: string | null;
  coverUrl?: string | null;
  subtype?: string | null; // TV | MOVIE | OVA | ONA | SPECIAL | MUSIC
  episodeCount?: number | null;
  episodeLength?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: string | null;
  ageRating?: string | null;
  genres?: string[];
  studios?: string[];
}

export interface NormalizedManga {
  providerEntityKind: 'MANGA';
  kitsuId?: string;
  malId?: string;
  title: string;
  canonicalTitle?: string | null;
  alternativeTitles?: string[];
  synopsis?: string | null;
  posterUrl?: string | null;
  coverUrl?: string | null;
  subtype?: string | null; // MANGA | NOVEL | MANHWA | MANHUA | OEL
  chapterCount?: number | null;
  volumeCount?: number | null;
  serialization?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  status?: string | null;
  genres?: string[];
}
