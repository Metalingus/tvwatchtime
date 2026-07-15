import { ExternalProvider } from '@tvwatch/shared';
import { mergeField, mergeFields, PRIORITY, priorityFor } from '@tvwatch/shared';

const K = ExternalProvider.KITSU;
const M = ExternalProvider.MYANIME_LIST;
const T = ExternalProvider.THE_TVDB;
const D = ExternalProvider.TMDB;

describe('mergeField — anime priority (Kitsu > Jikan/MAL > TVDB > TMDB)', () => {
  it('lets a higher-priority non-empty value replace a lower one', () => {
    const res = mergeField(
      'TVDB Title',
      [
        { provider: K, value: 'Kitsu Title' },
        { provider: T, value: 'TVDB Title' },
      ],
      PRIORITY.anime,
    );
    expect(res.value).toBe('Kitsu Title');
    expect(res.source).toBe(K);
  });

  it('lets a lower-priority value fill when Kitsu has none', () => {
    const res = mergeField(null, [{ provider: K, value: null }, { provider: M, value: 'MAL' }], PRIORITY.anime);
    expect(res.value).toBe('MAL');
    expect(res.source).toBe(M);
  });

  it('falls back to TVDB then TMDB when anime providers are empty', () => {
    const res = mergeField(null, [{ provider: D, value: 'TMDB' }, { provider: T, value: 'TVDB' }], PRIORITY.anime);
    expect(res.value).toBe('TVDB');
    expect(res.source).toBe(T);
  });

  it('never erases a useful value with an empty higher-priority one', () => {
    const res = mergeField('TMDB Overview', [{ provider: K, value: '' }, { provider: T, value: '' }], PRIORITY.anime);
    expect(res.value).toBe('TMDB Overview');
    expect(res.source).toBe(null);
  });

  it('never overwrites a manual value', () => {
    const res = mergeField('Manual', [{ provider: K, value: 'Kitsu' }], PRIORITY.anime, { isManual: true });
    expect(res.value).toBe('Manual');
    expect(res.changed).toBe(false);
  });
});

describe('mergeField — general priority (TMDB > TVDB)', () => {
  it('prefers TMDB over TVDB', () => {
    const res = mergeField(null, [{ provider: T, value: 'TVDB' }, { provider: D, value: 'TMDB' }], PRIORITY.general);
    expect(res.value).toBe('TMDB');
    expect(res.source).toBe(D);
  });
});

describe('priorityFor', () => {
  it('uses TVDB-only priority when no TMDB exists for general media', () => {
    const p = priorityFor({ classification: 'general', hasTmdb: false });
    expect(p[0]).toBe(T);
  });
  it('uses TMDB-first priority when TMDB exists', () => {
    const p = priorityFor({ classification: 'general', hasTmdb: true });
    expect(p[0]).toBe(D);
  });
});

describe('mergeFields — per-field provenance', () => {
  it('records the winning provider per field', () => {
    const current = { title: '', overview: 'Keep', genres: [] as string[] };
    const out = mergeFields(
      current,
      { [K]: { title: 'Kitsu Title', genres: ['Action'] }, [T]: { title: 'TVDB Title', overview: 'TVDB Ov' } },
      ['title', 'overview', 'genres'] as (keyof typeof current)[],
      PRIORITY.anime,
    );
    expect(out.merged.title).toBe('Kitsu Title');
    expect(out.merged.genres).toEqual(['Action']);
    expect(out.provenance.title).toEqual({ provider: K });
    // overview: no Kitsu value, TVDB provides one (lower priority fills)
    expect(out.merged.overview).toBe('TVDB Ov');
    expect(out.provenance.overview).toEqual({ provider: T });
  });
});
