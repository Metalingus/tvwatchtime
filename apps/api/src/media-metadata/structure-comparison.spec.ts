import { compareCompleteRegularStructures } from './structure-comparison';
import type { NormalizedSeason } from './providers/tmdb.provider';

const season = (number: number, episodes: Array<{ number: number; airDate?: string | null }>) =>
  ({
    tmdbId: number,
    number,
    title: `Season ${number}`,
    episodeCount: episodes.length,
    isSpecial: number === 0,
    episodes: episodes.map((episode) => ({
      tmdbId: number * 100 + episode.number,
      number: episode.number,
      title: `Episode ${episode.number}`,
      airDate: episode.airDate ?? null,
      isFinale: false,
    })),
  }) satisfies NormalizedSeason;

describe('compareCompleteRegularStructures', () => {
  it('treats equal TMDB and TVDB-official coordinates as equivalent', () => {
    const tmdb = [season(1, [{ number: 1 }, { number: 2 }])];
    const tvdb = [season(1, [{ number: 1 }, { number: 2 }])];

    expect(compareCompleteRegularStructures(tmdb, tvdb)).toMatchObject({
      equivalent: true,
      tmdbEpisodeCount: 2,
      tvdbEpisodeCount: 2,
      tmdbOnlyCount: 0,
      tvdbOnlyCount: 0,
    });
  });

  it('selects divergence when TVDB official contains an aired episode TMDB lacks', () => {
    const tmdb = [season(1, [{ number: 1 }])];
    const tvdb = [season(1, [{ number: 1 }, { number: 2, airDate: '2026-08-01' }])];

    expect(compareCompleteRegularStructures(tmdb, tvdb)).toMatchObject({
      equivalent: false,
      tmdbOnlyCount: 0,
      tvdbOnlyCount: 1,
      tvdbOnlyCoordinates: ['S1E2'],
    });
  });

  it('ignores specials but includes future official episodes', () => {
    const tmdb = [season(1, [{ number: 1 }])];
    const tvdb = [
      season(0, [{ number: 1 }]),
      season(1, [{ number: 1 }, { number: 2, airDate: '2026-09-01' }]),
    ];

    expect(compareCompleteRegularStructures(tmdb, tvdb)).toMatchObject({
      equivalent: false,
      tvdbOnlyCount: 1,
      tvdbOnlyCoordinates: ['S1E2'],
    });
  });
});
