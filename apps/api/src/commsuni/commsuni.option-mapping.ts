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
  characterExternalId: number | null;
  character: string | null;
  characterImageUrl: string | null;
  castMember: { name: string; profileUrl: string | null };
}

/** A cast option plus the read-only credit its archived TV Time counts display under. */
export type CastOptionDto = CommsUniOptionDto & { archivedCreditId?: string | null };

const normName = (value: string | null | undefined) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Archived TV Time rows (`actor:<n>`, `cast:<slug>`) carry a performer name and role but no TVDB
 * character id. For display only, attach them to the one local credit with that performer (and,
 * when the performer has several credits, that role). Vote writes never use this link: they keep
 * resolving through `localValue`, so new votes always go to `character:tvdb-<id>` keys.
 */
function archivedCredit(option: CommsUniOptionDto, cast: LocalCastIdentity[]): string | null {
  const name = normName(option.label);
  if (!name || option.label === option.key) return null;
  let matches = cast.filter((credit) => normName(credit.castMember.name) === name);
  if (matches.length > 1 && option.role)
    matches = matches.filter((credit) => normName(credit.character) === normName(option.role));
  return matches.length === 1 ? matches[0].id : null;
}

/**
 * Join only exact TVDB role keys within the already verified media (`localValue`, used for
 * votes). Legacy actor/cast keys never get a `localValue`; they get a display-only
 * `archivedCreditId` when one local credit matches their performer and role.
 * Provider role rows contain IDs only, so display metadata comes from our stored cast.
 */
export function mapCastOptions(
  options: CommsUniOptionDto[],
  cast: LocalCastIdentity[],
): CastOptionDto[] {
  return options.map((option) => {
    const characterId = /^character:tvdb-([1-9]\d*)$/.exec(option.key)?.[1];
    if (!characterId)
      return { ...option, localValue: null, archivedCreditId: archivedCredit(option, cast) };
    const matches = cast.filter(
      (credit) =>
        credit.characterExternalId != null && String(credit.characterExternalId) === characterId,
    );
    if (matches.length !== 1) return { ...option, localValue: null };
    const credit = matches[0];
    return {
      ...option,
      localValue: credit.id,
      label: credit.castMember.name,
      role: credit.character,
      imageUrl: credit.characterImageUrl ?? credit.castMember.profileUrl,
    };
  });
}

/** Select a returned, verified option without rewriting existing provider keys. */
export function preferredOption(
  options: CommsUniOptionDto[],
  value: string,
): CommsUniOptionDto | null {
  const matches = options.filter((option) => option.localValue === value);
  return [...matches].sort((a, b) => a.key.localeCompare(b.key))[0] ?? null;
}
