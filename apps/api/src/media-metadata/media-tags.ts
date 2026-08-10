import { MEDIA_TAG_SLUGS, MediaTagSlug } from '@tvwatch/shared';

export const MEDIA_TAG_RULE_VERSION = 1;

export interface MediaTagSignals {
  type: 'SHOW' | 'MOVIE';
  genres?: string[] | null;
  keywords?: unknown;
  language?: string | null;
  countries?: string[] | null;
}

const KNOWN_TAGS = new Set<string>(MEDIA_TAG_SLUGS);

export function parseMediaTagSlugs(value?: string): MediaTagSlug[] {
  return [
    ...new Set(
      (value ?? '')
        .split(',')
        .map((slug) => slug.trim().toLowerCase())
        .filter((slug): slug is MediaTagSlug => KNOWN_TAGS.has(slug)),
    ),
  ];
}

function normalizeSignal(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function keywordSet(raw: unknown): Set<string> {
  return new Set((Array.isArray(raw) ? raw : []).map(normalizeSignal).filter(Boolean));
}

export function deriveMediaTagSlugs(signals: MediaTagSignals): MediaTagSlug[] {
  const genres = new Set((signals.genres ?? []).map(normalizeSignal).filter(Boolean));
  const keywords = keywordSet(signals.keywords);
  const countries = new Set(
    (signals.countries ?? []).map((country) => String(country).trim().toUpperCase()),
  );
  const language = String(signals.language ?? '')
    .trim()
    .toLowerCase()
    .split('-')[0];
  const hasAnyKeyword = (...values: string[]) => values.some((value) => keywords.has(value));
  const hasDrama = genres.has('drama');
  const animated =
    genres.has('anime') || genres.has('animation') || hasAnyKeyword('anime', 'animation');
  const isShow = signals.type === 'SHOW';
  const tags: MediaTagSlug[] = [];

  if (
    isShow &&
    (['ko', 'kor'].includes(language) || countries.has('KR')) &&
    (hasDrama || hasAnyKeyword('korean drama', 'k drama', 'kdrama')) &&
    !animated
  ) {
    tags.push('k-drama');
  }
  if (
    isShow &&
    (['ja', 'jpn'].includes(language) || countries.has('JP')) &&
    (hasDrama || hasAnyKeyword('japanese drama', 'j drama', 'jdrama')) &&
    !animated
  ) {
    tags.push('j-drama');
  }
  if (
    isShow &&
    (['zh', 'zho', 'chi'].includes(language) ||
      ['CN', 'HK', 'TW'].some((country) => countries.has(country))) &&
    (hasDrama || hasAnyKeyword('chinese drama', 'c drama', 'cdrama')) &&
    !animated
  ) {
    tags.push('c-drama');
  }
  if (keywords.has('isekai')) tags.push('isekai');
  if (keywords.has('true crime')) tags.push('true-crime');
  if (genres.has('sitcom') || keywords.has('sitcom')) tags.push('sitcom');

  return tags;
}
