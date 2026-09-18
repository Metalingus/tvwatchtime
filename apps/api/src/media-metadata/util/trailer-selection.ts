export interface TmdbVideo {
  site?: string;
  type?: string;
  key?: string;
  name?: string;
  official?: boolean;
  published_at?: string;
}

export interface TvdbTrailer {
  id?: number;
  name?: string;
  url?: string;
  language?: string;
  runtime?: number;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

// Prefer a full/main trailer over specialty trailers such as countdown promos.
// Provider type remains the authority; names only rank valid trailer candidates.
function mainTrailer(name: string | undefined): number {
  return /^(?:official\s+)?(?:(?:new|final|main|international|red band)\s+)?trailer(?:\s*#?\d+)?$/i.test(
    name?.trim() ?? '',
  )
    ? 1
    : 0;
}

function explicitlyPromotional(name: string | undefined): boolean {
  return /^(?:official\s+)?(?:teaser(?:\s+trailer)?|promo(?:tional)?(?:\s+video)?|tv[ -]spot|clip|featurette|sneak peek|behind the scenes)(?:$|\s*[:|\-]|\s+\d)/i.test(
    name?.trim() ?? '',
  );
}

function youtubeUrl(key: string | undefined): string | null {
  return key && YOUTUBE_ID.test(key) ? 'https://www.youtube.com/watch?v=' + key : null;
}

export function selectTmdbTrailer(videos: readonly TmdbVideo[] | null = []): string | null {
  const candidates = (videos ?? []).filter(
    (video) =>
      video.site === 'YouTube' &&
      video.type === 'Trailer' &&
      video.official === true &&
      youtubeUrl(video.key) &&
      !explicitlyPromotional(video.name),
  );
  const published = (video: TmdbVideo) => {
    const timestamp = Date.parse(video.published_at ?? '');
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  candidates.sort(
    (a, b) =>
      mainTrailer(b.name) - mainTrailer(a.name) ||
      published(b) - published(a) ||
      (a.key ?? '').localeCompare(b.key ?? ''),
  );
  return youtubeUrl(candidates[0]?.key);
}

function tvdbYoutubeUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    if (url.hostname === 'youtu.be') return youtubeUrl(url.pathname.slice(1));
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname)) return null;
    if (url.pathname === '/watch') return youtubeUrl(url.searchParams.get('v') ?? undefined);
    if (url.pathname.startsWith('/embed/')) return youtubeUrl(url.pathname.slice(7));
  } catch {
    /* Invalid upstream link: no trailer button. */
  }
  return null;
}

/** TVDB's curated trailers records have no TMDB-style official/type flags. */
export function selectTvdbTrailer(
  trailers: readonly TvdbTrailer[] | null = [],
  language = 'eng',
): string | null {
  const languageRank = (trailer: TvdbTrailer) =>
    trailer.language === language ? 3 : trailer.language === 'eng' ? 2 : !trailer.language ? 1 : 0;
  const candidates = (trailers ?? [])
    .filter((trailer) => !explicitlyPromotional(trailer.name))
    .map((trailer) => ({ trailer, url: tvdbYoutubeUrl(trailer.url) }))
    .filter((candidate) => candidate.url !== null);
  candidates.sort(
    (a, b) =>
      languageRank(b.trailer) - languageRank(a.trailer) ||
      mainTrailer(b.trailer.name) - mainTrailer(a.trailer.name),
  );
  return candidates[0]?.url ?? null;
}
