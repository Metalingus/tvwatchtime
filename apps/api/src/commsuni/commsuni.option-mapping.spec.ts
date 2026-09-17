import {
  deviceValue,
  mapCastOptions,
  preferredOption,
  type LocalCastIdentity,
} from './commsuni.option-mapping';
const photo = 'https://artworks.thetvdb.com/banners/v4/actor/295149/photo/example.jpg';
const cast: LocalCastIdentity[] = [
  {
    id: 'local-credit',
    characterImageUrl: photo,
    castMember: { name: 'Rebecca Ferguson', tvdbId: 295149, externalId: 'TMDB_933238' },
  },
];
const option = (key = 'actor:53806') => ({
  key,
  label: 'Rebecca Ferguson',
  role: 'Juliette',
  imageUrl: photo,
  localValue: null,
  count: 1,
  selected: false,
});

it('maps a unique title-scoped performer using corroborating TVDB artwork identity, not the option number', () => {
  expect(mapCastOptions([option()], cast)[0].localValue).toBe('local-credit');
});
it('maps alias keys to one credit while keeping each original key and count', () => {
  const result = mapCastOptions([option(), option('cast:rebecca-ferguson-alias')], cast);
  expect(result.map((o) => o.localValue)).toEqual(['local-credit', 'local-credit']);
  expect(result.map((o) => o.key)).toEqual(['actor:53806', 'cast:rebecca-ferguson-alias']);
  expect(preferredOption(result, 'local-credit')?.key).toBe('actor:53806');
});
it('refuses names alone, conflicting person IDs, duplicate matching credits and foreign image hosts', () => {
  expect(mapCastOptions([{ ...option(), imageUrl: null }], cast)[0].localValue).toBeNull();
  expect(
    mapCastOptions(
      [option()],
      [{ ...cast[0], castMember: { ...cast[0].castMember, tvdbId: 999 } }],
    )[0].localValue,
  ).toBeNull();
  expect(
    mapCastOptions([option()], [cast[0], { ...cast[0], id: 'ambiguous' }])[0].localValue,
  ).toBeNull();
  expect(
    mapCastOptions(
      [{ ...option(), imageUrl: photo.replace('artworks.thetvdb.com', 'evil.test') }],
      cast,
    )[0].localValue,
  ).toBeNull();
});
it('refuses mismatched performer names even when artwork is reused', () => {
  expect(
    mapCastOptions([{ ...option(), label: 'Another performer' }], cast)[0].localValue,
  ).toBeNull();
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
