import type { CommsUniOptionDto } from '@tvwatch/shared';

const DEVICES: Record<string, string> = {
  'source:1': 'PHONE',
  'source:2': 'TABLET',
  'source:3': 'COMPUTER',
  'source:4': 'TV',
};

/** Require both the returned device key and its catalog meaning; never map platforms as devices. */
export function deviceValue(key: string, id: unknown, name: unknown): string | null {
  const value = DEVICES[key];
  return value &&
    key === 'source:' + String(id) &&
    typeof name === 'string' &&
    name.trim().toUpperCase() === value
    ? value
    : null;
}

export interface LocalCastIdentity {
  id: string;
  characterImageUrl: string | null;
  castMember: { name: string; tvdbId: number | null; externalId: string | null };
}

const normalizedName = (value: string) =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

/** The number in TVDB artwork URLs identifies the performer, not the CommsUni actor option. */
function artworkPerson(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'artworks.thetvdb.com' ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return /^\/banners\/(?:v4\/actor|person)\/([1-9]\d*)\//.exec(url.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve within the already verified media only. Require the provider's TVDB artwork identity,
 * a matching stored performer/role artwork identity, matching performer name, and one local credit.
 * Do not interpret actor:<id> as a TVDB/TMDB person or role ID, or match by name alone.
 * Several provider option keys can refer to one credit; keep every key for counts and removals.
 */
export function mapCastOptions(
  options: CommsUniOptionDto[],
  cast: LocalCastIdentity[],
): CommsUniOptionDto[] {
  return options.map((option) => {
    const person = artworkPerson(option.imageUrl);
    if (!person) return { ...option, localValue: null };
    const matches = cast.filter((credit) => {
      const member = credit.castMember;
      const storedIds = [
        member.tvdbId == null ? null : String(member.tvdbId),
        /^TVDB_([1-9]\d*)$/.exec(member.externalId ?? '')?.[1],
        artworkPerson(credit.characterImageUrl),
      ].filter((id): id is string => !!id);
      return (
        storedIds.length > 0 &&
        storedIds.every((id) => id === person) &&
        normalizedName(member.name) === normalizedName(option.label)
      );
    });
    return { ...option, localValue: matches.length === 1 ? matches[0].id : null };
  });
}

/** Deterministic write key; aliases remain independent counted choices in provider responses. */
export function preferredOption(
  options: CommsUniOptionDto[],
  value: string,
): CommsUniOptionDto | null {
  const matches = options.filter((option) => option.localValue === value);
  if (!matches.length) return null;
  return [...matches].sort((a, b) => {
    const rank = (key: string) => (/^actor:[1-9]\d*$/.test(key) ? 0 : 1);
    return rank(a.key) - rank(b.key) || a.key.localeCompare(b.key);
  })[0];
}
