import { ExternalProvider } from '@tvwatch/shared';
import { scoreAnimeCandidate, AnimeMatchService, type MatchInput } from './anime-match.service';
import { ProviderError } from '../providers/shared/provider-errors';
import type { NormalizedAnime } from '../providers/normalized-anime';

function anime(over: Partial<NormalizedAnime> = {}): NormalizedAnime {
  return {
    providerEntityKind: 'ANIME',
    malId: '1',
    title: 'Show',
    canonicalTitle: 'Show',
    alternativeTitles: [],
    synopsis: null,
    subtype: 'TV',
    startDate: '2019-04-01',
    episodeCount: 12,
    ...over,
  } as NormalizedAnime;
}

describe('scoreAnimeCandidate', () => {
  const input: MatchInput = { title: 'Show', year: 2019, structuralType: 'SHOW', episodeCount: 12 };

  it('scores a clean match highly', () => {
    expect(scoreAnimeCandidate(input, anime())).toBeGreaterThan(0.9);
  });

  it('rejects a same-title work a decade apart (remake/sequel/unrelated)', () => {
    // same title, very different year → guard returns 0
    expect(scoreAnimeCandidate(input, anime({ startDate: '2009-04-01' }))).toBe(0);
  });

  it('rejects when there is no title similarity', () => {
    expect(scoreAnimeCandidate({ ...input, title: 'Completely Different' }, anime({ title: 'Unrelated' }))).toBe(0);
  });

  it('penalizes a series-vs-movie mismatch (recap/compilation film)', () => {
    const seriesInput: MatchInput = { title: 'Show', year: 2019, structuralType: 'SHOW', episodeCount: 12 };
    const movieCand = anime({ subtype: 'MOVIE', episodeCount: 1, startDate: '2019-06-01' });
    expect(scoreAnimeCandidate(seriesInput, movieCand)).toBeLessThan(0.85);
  });

  it('keeps a close-year candidate viable (split cour / sequel adjacent year)', () => {
    expect(scoreAnimeCandidate(input, anime({ startDate: '2020-04-01' }))).toBeGreaterThan(0.7);
  });

  it('treats unknown year leniently', () => {
    const noYear: MatchInput = { title: 'Show', structuralType: 'SHOW', episodeCount: 12 };
    expect(scoreAnimeCandidate(noYear, anime())).toBeGreaterThan(0.5);
  });
});

describe('AnimeMatchService', () => {
  const fakeKitsu = (cands: NormalizedAnime[] | 'throw') => ({
    searchAnime: async () => {
      if (cands === 'throw') throw new ProviderError('upstream', 'kitsu down', 503);
      return cands;
    },
  });
  const fakeJikan = (cands: NormalizedAnime[] | 'throw') => ({
    searchAnime: async () => {
      if (cands === 'throw') throw new ProviderError('upstream', 'jikan down', 503);
      return cands;
    },
  });

  it('matches via Kitsu when a reliable candidate exists (Jikan not needed)', async () => {
    const svc = new AnimeMatchService(fakeKitsu([anime({ kitsuId: '9' })]) as any, fakeJikan([]) as any);
    const res = await svc.matchAnime({ title: 'Show', year: 2019, structuralType: 'SHOW', episodeCount: 12 });
    expect(res.matched).toBe(true);
    expect(res.provider).toBe(ExternalProvider.KITSU);
  });

  it('falls back to Jikan/MyAnimeList when Kitsu has no reliable match', async () => {
    const svc = new AnimeMatchService(fakeKitsu([]) as any, fakeJikan([anime({ malId: '42' })]) as any);
    const res = await svc.matchAnime({ title: 'Show', year: 2019, structuralType: 'SHOW', episodeCount: 12 });
    expect(res.matched).toBe(true);
    expect(res.provider).toBe(ExternalProvider.MYANIME_LIST);
  });

  it('returns no_result when neither provider has a reliable candidate', async () => {
    const svc = new AnimeMatchService(fakeKitsu([]) as any, fakeJikan([]) as any);
    const res = await svc.matchAnime({ title: 'Show', year: 2019 });
    expect(res.matched).toBe(false);
    expect(res.reason).toBe('no_result');
  });

  it('reports provider_unavailable when Jikan throws after Kitsu misses', async () => {
    const svc = new AnimeMatchService(fakeKitsu([]) as any, fakeJikan('throw') as any);
    const res = await svc.matchAnime({ title: 'Show', year: 2019 });
    expect(res.matched).toBe(false);
    expect(res.reason).toBe('provider_unavailable');
  });
});
