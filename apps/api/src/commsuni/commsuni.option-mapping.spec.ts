import {
  deviceValue,
  mapCastOptions,
  preferredOption,
  type LocalCastIdentity,
} from './commsuni.option-mapping';
import { sharedCharacterSection } from './commsuni.voting.service';

const photo = 'https://artworks.thetvdb.com/banners/v4/actor/295149/photo/example.jpg';
const cast: LocalCastIdentity[] = [
  {
    id: 'local-credit',
    characterExternalId: 64178863,
    character: 'Juliette',
    characterImageUrl: photo,
    castMember: { name: 'Rebecca Ferguson', profileUrl: null },
  },
];
const option = (key = 'character:tvdb-64178863') => ({
  key,
  label: key,
  role: '',
  imageUrl: null,
  localValue: null,
  count: 3,
  selected: false,
});

it('resolves ID-only options by exact TVDB role and supplies local display metadata', () => {
  expect(mapCastOptions([option()], cast)[0]).toEqual({
    ...option(),
    localValue: 'local-credit',
    label: 'Rebecca Ferguson',
    role: 'Juliette',
    imageUrl: photo,
  });
});

it('never joins legacy cast counts by matching names or artwork', () => {
  const legacy = { ...option('actor:53806'), label: 'Rebecca Ferguson', imageUrl: photo };
  const result = mapCastOptions([legacy, option()], cast);
  expect(result.map((o) => o.localValue)).toEqual([null, 'local-credit']);
  expect(preferredOption(result, 'local-credit')?.key).toBe('character:tvdb-64178863');
  const section = sharedCharacterSection(
    { options: [], total: 0, userVote: null } as any,
    result,
    new Map(),
    null,
  );
  expect(section.options).toEqual([{ castId: 'local-credit', count: 3 }]);
  expect(section.unmappedOptions).toEqual([
    expect.objectContaining({ key: 'actor:53806', count: 3 }),
  ]);
  expect(section.total).toBe(6);
});

it('does not guess missing, malformed, or ambiguous role mappings', () => {
  for (const key of [
    'character:tvdb-295149',
    'character:tvdb-0',
    'character:tvdb-064178863',
    'cast:juliette',
  ])
    expect(mapCastOptions([option(key)], cast)[0].localValue).toBeNull();
  expect(
    mapCastOptions([option()], [{ ...cast[0], characterExternalId: null }])[0].localValue,
  ).toBeNull();
  expect(
    mapCastOptions([option()], [cast[0], { ...cast[0], id: 'duplicate' }])[0].localValue,
  ).toBeNull();
});

it('keeps different roles distinct even for the same performer', () => {
  const other = {
    ...cast[0],
    id: 'other-credit',
    characterExternalId: 123,
    character: 'Other role',
  };
  const result = mapCastOptions([option(), option('character:tvdb-123')], [cast[0], other]);
  expect(result.map((o) => o.localValue)).toEqual(['local-credit', 'other-credit']);
});

it('uses a person portrait only as a display fallback', () => {
  const result = mapCastOptions(
    [option()],
    [
      {
        ...cast[0],
        characterImageUrl: null,
        castMember: { ...cast[0].castMember, profileUrl: photo },
      },
    ],
  );
  expect(result[0].imageUrl).toBe(photo);
});

it('omits unresolved ID-only options from the cast UI without rewriting their keys', () => {
  const remote = mapCastOptions([option('actor:999'), option('character:tvdb-999')], cast);
  const section = sharedCharacterSection(
    { options: [], total: 0, userVote: null } as any,
    remote,
    new Map(),
    null,
  );
  expect(section.unmappedOptions).toEqual([]);
  expect(remote.map((o) => o.key)).toEqual(['actor:999', 'character:tvdb-999']);
});

it.each([
  ['source:1', '1', 'Phone', 'PHONE'],
  ['source:2', '2', 'Tablet', 'TABLET'],
  ['source:3', '3', 'Computer', 'COMPUTER'],
  ['source:4', '4', 'TV', 'TV'],
])('maps catalog device %s only with corroborating id and meaning', (key, id, name, expected) => {
  expect(deviceValue(key, id, name)).toBe(expected);
});
it('does not infer devices from platforms or mismatched catalog IDs', () => {
  expect(deviceValue('network:1', '1', 'Phone')).toBeNull();
  expect(deviceValue('source:1', '2', 'Phone')).toBeNull();
  expect(deviceValue('source:1', '1', 'TV')).toBeNull();
  expect(deviceValue('source:9', '9', 'Phone')).toBeNull();
});
