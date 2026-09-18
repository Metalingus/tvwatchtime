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

/**
 * Join only exact TVDB role keys within the already verified media.
 * Legacy actor/cast keys are separate counted choices, never aliases for a role.
 * Provider role rows contain IDs only, so display metadata comes from our stored cast.
 */
export function mapCastOptions(
  options: CommsUniOptionDto[],
  cast: LocalCastIdentity[],
): CommsUniOptionDto[] {
  return options.map((option) => {
    const characterId = /^character:tvdb-([1-9]\d*)$/.exec(option.key)?.[1];
    if (!characterId) return { ...option, localValue: null };
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
