import type { GalleryImageDto } from '@tvwatch/shared';

export function landscapeGallery(images: readonly GalleryImageDto[]) {
  return images.filter((image) => image.kind === 'BACKDROP' || image.kind === 'STILL');
}

export function nextHeroIndex(current: number, count: number) {
  return count > 1 ? (current + 1) % count : 0;
}

export function galleryIndexForHero(images: readonly GalleryImageDto[], hero?: GalleryImageDto) {
  if (!hero) return 0;
  return Math.max(
    0,
    images.findIndex((image) => image.id === hero.id),
  );
}
