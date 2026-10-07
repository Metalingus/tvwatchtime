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

const section = (remote: ReturnType<typeof mapCastOptions>) =>
  sharedCharacterSection({ options: [], total: 0, userVote: null } as any, remote, new Map(), null);

it('shows archived counts on the matching credit but never votes through a legacy key', () => {
  const legacy = { ...option('actor:53806'), label: 'Rebecca Ferguson', imageUrl: photo };
  const result = mapCastOptions([legacy, option()], cast);
  // Votes resolve only through exact TVDB role keys.
  expect(result.map((o) => o.localValue)).toEqual([null, 'local-credit']);
  expect(preferredOption(result, 'local-credit')?.key).toBe('character:tvdb-64178863');
  // Display: one votable character with both counts, no read-only duplicate tile.
  expect(section(result).options).toEqual([{ castId: 'local-credit', count: 6 }]);
  expect(section(result).unmappedOptions).toEqual([]);
  expect(section(result).total).toBe(6);
});

it('counts one archived vote set returned under several keys once', () => {
  // Observed for The Handmaid's Tale: the same votes under actor:, cast: and cast:-hash keys.
  const aliases = ['actor:33914', 'cast:rebecca-ferguson', 'cast:rebecca-ferguson-92628fb3'].map(
    (key) => ({ ...option(key), label: 'Rebecca Ferguson', role: 'Juliette', count: 8308 }),
  );
  const mapped = section(mapCastOptions([...aliases, option()], cast));
  expect(mapped.options).toEqual([{ castId: 'local-credit', count: 8308 + 3 }]);
  expect(mapped.total).toBe(8311);
  // Without a local credit they stay one read-only tile, counted once.
  const unmatched = section(mapCastOptions(aliases, []));
  expect(unmatched.unmappedOptions).toEqual([
    expect.objectContaining({ key: 'actor:33914', name: 'Rebecca Ferguson', count: 8308 }),
  ]);
  expect(unmatched.total).toBe(8308);
});

it('adds archived rows that are genuinely different', () => {
  const rows = [
    { ...option('actor:1'), label: 'Rebecca Ferguson', role: 'Juliette', count: 5 },
    { ...option('cast:rebecca-ferguson'), label: 'Rebecca Ferguson', role: 'Juliette', count: 2 },
  ];
  expect(section(mapCastOptions(rows, cast)).options).toEqual([
    { castId: 'local-credit', count: 7 },
  ]);
});

it('needs the role to pick between two credits of the same performer', () => {
  const second = { ...cast[0], id: 'second-credit', characterExternalId: 5, character: 'Other' };
  const ambiguous = { ...option('actor:1'), label: 'Rebecca Ferguson', role: '' };
  const withRole = { ...option('actor:2'), label: 'Rebecca Ferguson', role: 'Other' };
  const [a, b] = mapCastOptions([ambiguous, withRole], [cast[0], second]);
  expect(a.archivedCreditId).toBeNull();
  expect(b.archivedCreditId).toBe('second-credit');
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
