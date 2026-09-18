/** A detail placeholder keeps the requested media identity, including episode -> show links. */
export function mediaSeedToDetail(seed: any, mediaId: string) {
  const fromShowLink = seed.showId === mediaId;
  const images = fromShowLink ? seed.showImages : seed.images;
  return {
    id: mediaId,
    title: fromShowLink ? seed.showTitle : seed.title,
    yearStart: fromShowLink ? undefined : seed.year,
    releaseYear: fromShowLink ? undefined : seed.year,
    rating: fromShowLink ? undefined : seed.rating,
    images: {
      poster: images?.poster ?? seed.posterUrl ?? null,
      backdrop: images?.backdrop ?? seed.backdropUrl ?? null,
    },
  };
}
