import { localized, mergeLocalized } from './localization.util';

describe('localized — read fallback chain (lang → en → base)', () => {
  it('returns the locale override when present', () => {
    expect(localized({ titles: { fr: 'Fr' } }, 'titles', 'title', 'fr')).toBe('Fr');
  });

  it('falls back to the English override when the locale is missing', () => {
    expect(localized({ titles: { fr: 'Fr', en: 'En' } }, 'titles', 'title', 'es')).toBe('En');
  });

  it('falls back to the base column when no override matches', () => {
    expect(localized({ titles: { fr: 'Fr' }, title: 'Base' }, 'titles', 'title', 'es')).toBe('Base');
  });

  it('skips empty-string overrides so the fallback engages', () => {
    expect(localized({ titles: { fr: '' }, title: 'Base' }, 'titles', 'title', 'fr')).toBe('Base');
  });

  it('returns undefined for a missing record', () => {
    expect(localized(null, 'titles', 'title', 'fr')).toBeUndefined();
  });

  it('uses the base for English when no en override exists', () => {
    expect(localized({ titles: { fr: 'Fr' }, title: 'Base' }, 'titles', 'title', 'en')).toBe('Base');
  });
});

describe('mergeLocalized — write merge (locale + en base)', () => {
  it('stores both the locale value and the english base', () => {
    expect(mergeLocalized(null, 'fr', 'Fr', 'En')).toEqual({ en: 'En', fr: 'Fr' });
  });

  it('preserves other locales already stored', () => {
    expect(mergeLocalized({ de: 'De' }, 'fr', 'Fr', 'En')).toEqual({ de: 'De', en: 'En', fr: 'Fr' });
  });

  it('stores only english when the locale is english', () => {
    expect(mergeLocalized(null, 'en', 'En', undefined)).toEqual({ en: 'En' });
  });

  it('skips empty values but keeps the english base', () => {
    expect(mergeLocalized(null, 'fr', '', 'En')).toEqual({ en: 'En' });
  });

  it('skips the english base when not provided', () => {
    expect(mergeLocalized(null, 'fr', 'Fr', undefined)).toEqual({ fr: 'Fr' });
  });

  it('stores the locale even when english is null (list upsert case)', () => {
    expect(mergeLocalized({ en: 'En' }, 'es', 'Es', null)).toEqual({ en: 'En', es: 'Es' });
  });
});
