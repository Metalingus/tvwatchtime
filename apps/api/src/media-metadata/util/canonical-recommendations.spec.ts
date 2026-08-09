import { MediaType } from '@tvwatch/shared';
import { mergeCanonicalRecommendations, recommendationItems } from './canonical-recommendations';

const show = (tmdbId: number, title: string, rating = 7) => ({
  tmdbId,
  type: MediaType.SHOW,
  title,
  rating,
});

describe('canonical recommendations', () => {
  it('ranks cross-component agreement first and removes family/self recommendations', () => {
    const merged = mergeCanonicalRecommendations(
      [
        [show(10, 'A'), show(20, 'Shared'), show(113988, 'Dahmer')],
        [show(20, 'Shared', 8), show(30, 'B'), show(225634, 'Menendez')],
        [show(40, 'C'), show(20, 'Shared', 7.5), show(286801, 'Ed Gein')],
      ],
      new Set([113988, 225634, 286801, 329491]),
    );

    expect(merged[0]).toEqual(show(20, 'Shared', 8));
    expect(merged.map((item) => item.tmdbId)).toEqual([20, 10, 40, 30]);
  });

  it('parses persisted JSON defensively', () => {
    expect(
      recommendationItems([
        show(10, 'Valid'),
        null,
        { tmdbId: 'bad', type: MediaType.SHOW, title: 'Invalid' },
        { tmdbId: 11, type: MediaType.SHOW, title: '' },
      ]),
    ).toEqual([show(10, 'Valid')]);
    expect(recommendationItems({})).toEqual([]);
  });
});
