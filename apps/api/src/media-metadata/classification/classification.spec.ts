import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { CandidateDetectorService } from './candidate-detector.service';
import { ClassifierService } from './classifier.service';

const detector = new CandidateDetectorService();
const classifier = new ClassifierService();

const animeId = (provider: ExternalProvider) => ({ provider, providerEntityKind: ProviderEntityKind.ANIME, value: '1' });

describe('CandidateDetectorService', () => {
  it('flags a TMDB Animation genre as a candidate', () => {
    const r = detector.detect({ genres: ['Animation', 'Comedy'] });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('animation_genre');
  });

  it('flags a verified MAL anime id even with missing genres', () => {
    const r = detector.detect({ externalIds: [animeId(ExternalProvider.MYANIME_LIST)] });
    expect(r.isCandidate).toBe(true);
    expect(r.hasVerifiedAnimeId).toBe(true);
  });

  it('flags a TVDB anime type signal', () => {
    const r = detector.detect({ tvdbType: 'Anime' });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('tvdb_anime_signal');
  });

  it('respects a manual candidate override', () => {
    const r = detector.detect({ manualCandidate: true });
    expect(r.isCandidate).toBe(true);
    expect(r.signals).toContain('manual_candidate');
  });

  it('does not flag a non-animated item as candidate (JP origin alone is supporting, not a trigger)', () => {
    const r = detector.detect({ genres: ['Drama'], originalLanguage: 'ja', originCountries: ['JP'] });
    expect(r.isCandidate).toBe(false);
    expect(r.evidence.japaneseLanguage).toBe(true); // recorded but not a trigger
  });
});

describe('ClassifierService', () => {
  it('confirms ANIME from a TMDB animated JP show with a reliable Kitsu match', () => {
    const c = detector.detect({ genres: ['Animation'], originalLanguage: 'ja', originCountries: ['JP'] });
    const out = classifier.classify(c, { matched: true, provider: ExternalProvider.KITSU, externalId: '9', confidence: 0.95 });
    expect(out.classification).toBe('ANIME');
    expect(out.tier).toBe('confirmed');
    expect(out.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('confirms ANIME from an animated JP movie with a reliable Jikan match', () => {
    const c = detector.detect({ genres: ['Animation'], originalLanguage: 'ja' });
    const out = classifier.classify(c, { matched: true, provider: ExternalProvider.MYANIME_LIST, externalId: '5', confidence: 0.88 });
    expect(out.classification).toBe('ANIME');
    expect(out.tier).toBe('confirmed');
  });

  it('classifies probable ANIME when Kitsu and Jikan are unavailable but evidence is strong', () => {
    const c = detector.detect({ genres: ['Animation'], originalLanguage: 'ja', originCountries: ['JP'], studios: ['Madhouse'] });
    const out = classifier.classify(c, { matched: false, reason: 'provider_unavailable' });
    expect(out.classification).toBe('ANIME');
    expect(out.tier).toBe('probable');
    expect(out.confidence).toBeGreaterThan(0.4);
  });

  it('keeps Western animation (animation alone) as GENERAL at candidate tier', () => {
    const c = detector.detect({ genres: ['Animation'] }); // no JP signals
    const out = classifier.classify(c, { matched: false, reason: 'no_result' });
    expect(out.classification).toBe('GENERAL');
    expect(out.tier).toBe('candidate');
  });

  it('leaves a non-candidate as GENERAL', () => {
    const c = detector.detect({ genres: ['Drama'] });
    const out = classifier.classify(c, undefined);
    expect(out.classification).toBe('GENERAL');
  });

  it('keeps Japanese live-action as GENERAL (not anime)', () => {
    const c = detector.detect({ genres: ['Drama'], originalLanguage: 'ja', originCountries: ['JP'] });
    expect(c.isCandidate).toBe(false);
    expect(classifier.classify(c, undefined).classification).toBe('GENERAL');
  });

  it('upgrades a probable item to confirmed when a reliable mapping is later found', () => {
    const c = detector.detect({ genres: ['Animation'], originalLanguage: 'ja' });
    const first = classifier.classify(c, { matched: false, reason: 'provider_unavailable' });
    expect(first.tier).toBe('probable');
    const later = classifier.classify(c, { matched: true, provider: ExternalProvider.KITSU, externalId: '7', confidence: 0.92 });
    expect(later.tier).toBe('confirmed');
    expect(later.classification).toBe('ANIME');
  });

  it('confirms ANIME with a verified MAL id even when genres are incomplete', () => {
    const c = detector.detect({ externalIds: [animeId(ExternalProvider.MYANIME_LIST)] });
    const out = classifier.classify(c, { matched: true, provider: ExternalProvider.MYANIME_LIST, externalId: '1' });
    expect(out.classification).toBe('ANIME');
    expect(out.tier).toBe('confirmed');
  });
});
