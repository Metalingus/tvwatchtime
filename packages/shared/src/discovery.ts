import { MediaType, MediaStatus } from './enums';
import { ImageSet, PaginationQuery } from './common';
import type { ShowDto, MovieDto } from './media';

/** Stable, provider-independent catalog facets shown by the Explore tag filter. */
export const MEDIA_TAG_SLUGS = [
  'k-drama',
  'j-drama',
  'c-drama',
  'isekai',
  'true-crime',
  'sitcom',
] as const;
export type MediaTagSlug = (typeof MEDIA_TAG_SLUGS)[number];

export interface DiscoverQuery extends PaginationQuery {
  type?: MediaType;
  /** Comma-separated genre ids or slugs; every selected genre must match. */
  genre?: string;
  /** Comma-separated curated tag slugs; multiple values use OR semantics. */
  tags?: string;
  network?: string;
  yearFrom?: number;
  yearTo?: number;
  status?: MediaStatus;
  minRuntime?: number;
  maxRuntime?: number;
  country?: string;
  language?: string;
  minRating?: number;
  provider?: string;
  sort?: 'TRENDING' | 'POPULAR' | 'RATING' | 'RECENT' | 'MATCH';
}

/**
 * A card in a discovery/list response. The list endpoints (search/discover/trending/
 * watchlist/favorites) return full ShowDto | MovieDto rows (via fetchListDtos), so
 * consumers can read `type`, `title`, `images.poster`, etc. directly.
 */
export type MediaCardDto = ShowDto | MovieDto;

/**
 * Lightweight card for poster-only surfaces (Explore rails and large user lists).
 * Full ShowDto|MovieDto rows stay available to detail-rich discovery contexts.
 */
export interface MediaCardLiteDto {
  id: string;
  type: MediaType;
  title: string;
  images: ImageSet;
  /** TMDB vote average (1..10) — null until the row carries a rating. */
  rating?: number | null;
  /** Release/start year (show.yearStart / movie.releaseYear). */
  year?: number | null;
  inWatchlist?: boolean;
  favorite?: boolean;
  /** Shows only: 0..1 watched fraction of AIRED episodes. */
  userProgress?: number;
  /** Movies only. */
  watched?: boolean;
}

/** Genre row for filter UIs (explore/search/see-all chips), most-used first. */
export interface GenreFilterDto {
  id: string;
  name: string;
  slug: string;
}

export interface DiscoverSectionsDto {
  trendingShows: MediaCardLiteDto[];
  trendingMovies: MediaCardLiteDto[];
  topRatedShows: MediaCardLiteDto[];
  topRatedMovies: MediaCardLiteDto[];
  nowPlayingMovies: MediaCardLiteDto[];
  upcomingMovies?: MediaCardLiteDto[];
}

/** Streaming services with an official daily top chart (Movie of the Night service ids). */
export const STREAMING_TOP_SERVICES = ['netflix', 'prime', 'disney', 'apple', 'hbo'] as const;
export type StreamingTopService = (typeof STREAMING_TOP_SERVICES)[number];
/** Brand names are never translated. */
export const STREAMING_TOP_SERVICE_NAMES: Record<StreamingTopService, string> = {
  netflix: 'Netflix',
  prime: 'Prime Video',
  disney: 'Disney+',
  apple: 'Apple TV',
  hbo: 'HBO Max',
};
/**
 * Chart countries an admin can pick: the countries the API derives for a viewer from the app
 * language (`requestOfferCountry`), so every paid chart is reachable by someone.
 */
export const STREAMING_TOP_COUNTRIES = [
  'US',
  'FR',
  'DE',
  'ES',
  'IT',
  'BR',
  'JP',
  'KR',
  'IN',
  'TR',
  'ID',
] as const;
export const STREAMING_TOP_SECTION_IDS = [
  'netflixTopShows',
  'netflixTopMovies',
  'primeTopShows',
  'primeTopMovies',
  'disneyTopShows',
  'disneyTopMovies',
  'appleTopShows',
  'appleTopMovies',
  'hboTopShows',
  'hboTopMovies',
] as const;
export type StreamingTopSectionId = (typeof STREAMING_TOP_SECTION_IDS)[number];
export function isStreamingTopSectionId(id: string): id is StreamingTopSectionId {
  return (STREAMING_TOP_SECTION_IDS as readonly string[]).includes(id);
}
export function streamingTopSection(
  id: string,
): { service: StreamingTopService; kind: 'shows' | 'movies' } | null {
  if (!isStreamingTopSectionId(id)) return null;
  const kind = id.endsWith('TopShows') ? 'shows' : 'movies';
  return { service: id.slice(0, id.indexOf('Top')) as StreamingTopService, kind };
}
export function streamingTopSectionId(
  service: StreamingTopService,
  kind: 'shows' | 'movies',
): StreamingTopSectionId {
  return `${service}Top${kind === 'shows' ? 'Shows' : 'Movies'}` as StreamingTopSectionId;
}

/** GET /discover/streaming-top. Rails are ranked; `fallback` means the US chart was served. */
export interface StreamingTopDto {
  country: string;
  fallback: boolean;
  generatedAt: string | null;
  sections: Partial<Record<StreamingTopSectionId, MediaCardLiteDto[]>>;
}

/** Default Explore order. New/unknown saved layouts are normalized against these IDs. */
export const EXPLORE_SECTION_IDS = [
  'topShowsForYou',
  'topMoviesForYou',
  'trendingShows',
  'trendingMovies',
  'nowPlayingMovies',
  'upcomingMovies',
  'topRatedShows',
  'topRatedMovies',
  ...STREAMING_TOP_SECTION_IDS,
] as const;
export type ExploreSectionId = (typeof EXPLORE_SECTION_IDS)[number];
export interface ExploreSectionPreferences {
  order: ExploreSectionId[];
  hidden: ExploreSectionId[];
}
function validExploreSectionIds(items: unknown): ExploreSectionId[] {
  return Array.isArray(items)
    ? [
        ...new Set(
          items.filter(
            (id): id is ExploreSectionId =>
              typeof id === 'string' && (EXPLORE_SECTION_IDS as readonly string[]).includes(id),
          ),
        ),
      ]
    : [];
}
export function normalizeExploreSections(value: unknown): ExploreSectionPreferences {
  const data = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const order = validExploreSectionIds(data.order);
  return {
    order: [...order, ...EXPLORE_SECTION_IDS.filter((id) => !order.includes(id))],
    hidden: validExploreSectionIds(data.hidden),
  };
}

/**
 * Save-side merge. Clients always send every section id they know, so a stored id missing
 * from the client's raw order is one an older build doesn't know: it keeps its stored hidden
 * state and its position next to the stored neighbour that precedes it.
 */
export function mergeExploreSections(stored: unknown, incoming: unknown): ExploreSectionPreferences {
  if (!stored || typeof stored !== 'object') return normalizeExploreSections(incoming);
  const previous = normalizeExploreSections(stored);
  const data = incoming && typeof incoming === 'object' ? (incoming as Record<string, unknown>) : {};
  const sent = new Set(validExploreSectionIds(data.order));
  const order: ExploreSectionId[] = [...sent];
  previous.order.forEach((id, index) => {
    if (sent.has(id)) return;
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const pos = order.indexOf(previous.order[i]!);
      if (pos >= 0) {
        at = pos + 1;
        break;
      }
    }
    order.splice(at, 0, id);
  });
  const hidden = [
    ...validExploreSectionIds(data.hidden),
    ...previous.hidden.filter((id) => !sent.has(id)),
  ];
  return normalizeExploreSections({ order, hidden });
}

/** Drops ids from a layout (e.g. sections the connected API doesn't offer). */
export function withoutExploreSections(
  value: ExploreSectionPreferences,
  ids: readonly string[],
): ExploreSectionPreferences {
  const drop = new Set(ids);
  return {
    order: value.order.filter((id) => !drop.has(id)),
    hidden: value.hidden.filter((id) => !drop.has(id)),
  };
}

/** Mondays at 03:00; the default scheduled row uses UTC. */
export const DEFAULT_UPCOMING_MOVIES_SCHEDULE = '0 3 * * 1';
