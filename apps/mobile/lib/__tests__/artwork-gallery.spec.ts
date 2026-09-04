import { ExternalProvider, type GalleryImageDto } from '@tvwatch/shared';
import { galleryIndexForHero, landscapeGallery, nextHeroIndex } from '../artwork-gallery';

const image = (id: string, kind: GalleryImageDto['kind']): GalleryImageDto => ({
  id,
  sourceKey: `TMDB:SERIES:1:${id}`,
  kind,
  provider: ExternalProvider.TMDB,
  url: `https://image.tmdb.org/t/p/original/${id}.jpg`,
});

describe('artwork gallery helpers', () => {
  const images = [
    image('backdrop', 'BACKDROP'),
    image('poster', 'POSTER'),
    image('still', 'STILL'),
  ];

  it('rotates only landscape backdrops and stills', () => {
    expect(landscapeGallery(images).map((item) => item.id)).toEqual(['backdrop', 'still']);
  });

  it('wraps the six-second hero sequence deterministically', () => {
    expect(nextHeroIndex(0, 2)).toBe(1);
    expect(nextHeroIndex(1, 2)).toBe(0);
    expect(nextHeroIndex(0, 1)).toBe(0);
  });

  it('opens the full gallery at the currently displayed hero image', () => {
    expect(galleryIndexForHero(images, images[2])).toBe(2);
    expect(galleryIndexForHero(images, undefined)).toBe(0);
  });
});
