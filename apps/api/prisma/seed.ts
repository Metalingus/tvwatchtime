import { PrismaClient, MediaType, ExternalProvider } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const POSTER = (seed: string) => `https://picsum.photos/seed/${seed}/500/750`;
const BACKDROP = (seed: string) => `https://picsum.photos/seed/${seed}/1280/720`;
const STILL = (seed: string) => `https://picsum.photos/seed/${seed}/400/225`;

const slug = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function upsertGenre(name: string) {
  return prisma.genre.upsert({ where: { slug: slug(name) }, create: { name, slug: slug(name) }, update: {} });
}
async function upsertProvider(name: string) {
  return prisma.watchProvider.upsert({
    where: { slug: slug(name) },
    create: { name, slug: slug(name), logoUrl: `https://picsum.photos/seed/${name}/92/92` },
    update: {},
  });
}

async function makeShow(opts: {
  title: string;
  overview: string;
  network: string;
  genreNames: string[];
  providerNames: string[];
  seasons: { title: string; episodes: { title: string; airedDaysAgo?: number; airsInDays?: number }[] }[];
  tmdb?: number;
}) {
  const genres = await Promise.all(opts.genreNames.map(upsertGenre));
  const providers = await Promise.all(opts.providerNames.map(upsertProvider));
  const seed = slug(opts.title);
  const media = await prisma.mediaItem.upsert({
    where: { id: `seed-show-${seed}` },
    create: {
      id: `seed-show-${seed}`,
      type: MediaType.SHOW,
      title: opts.title,
      overview: opts.overview,
      posterUrl: POSTER(seed),
      backdropUrl: BACKDROP(seed),
      status: 'RETURNING',
      rating: 8 + Math.random(),
      popularity: 100 - opts.title.length,
      externalIds: opts.tmdb ? { create: [{ provider: ExternalProvider.TMDB, value: String(opts.tmdb) }] } : undefined,
      genres: { create: genres.map((g) => ({ genreId: g.id })) },
      providers: { create: providers.map((p) => ({ providerId: p.id })) },
      show: {
        create: {
          yearStart: 2019,
          network: opts.network,
          runtimeMinutes: 45,
          seasonsCount: opts.seasons.length,
          episodesCount: opts.seasons.reduce((a, s) => a + s.episodes.length, 0),
          inProduction: true,
        },
      },
    },
    update: {},
    include: { show: true },
  });

  for (let si = 0; si < opts.seasons.length; si++) {
    const s = opts.seasons[si];
    const season = await prisma.season.create({
      data: {
        showId: media.show!.id,
        number: si + 1,
        title: s.title,
        posterUrl: POSTER(`${seed}-s${si + 1}`),
        episodeCount: s.episodes.length,
        airedCount: s.episodes.filter((e) => e.airedDaysAgo !== undefined).length,
      },
    });
    for (let ei = 0; ei < s.episodes.length; ei++) {
      const e = s.episodes[ei];
      let airDate: Date | null = null;
      if (e.airedDaysAgo !== undefined) airDate = new Date(Date.now() - e.airedDaysAgo * 86400000);
      else if (e.airsInDays !== undefined) airDate = new Date(Date.now() + e.airsInDays * 86400000);
      await prisma.episode.create({
        data: {
          seasonId: season.id,
          number: ei + 1,
          title: e.title,
          overview: `Episode ${ei + 1} of ${opts.title}.`,
          stillUrl: STILL(`${seed}-s${si + 1}-e${ei + 1}`),
          runtimeMinutes: 45,
          airDate,
          rating: 7.5 + Math.random(),
          isFinale: ei === s.episodes.length - 1,
        },
      });
    }
  }
  return media;
}

async function makeMovie(opts: { title: string; overview: string; genreNames: string[]; providerNames: string[]; releaseYear: number; runtime: number; tmdb?: number }) {
  const genres = await Promise.all(opts.genreNames.map(upsertGenre));
  const providers = await Promise.all(opts.providerNames.map(upsertProvider));
  const seed = slug(opts.title);
  return prisma.mediaItem.upsert({
    where: { id: `seed-movie-${seed}` },
    create: {
      id: `seed-movie-${seed}`,
      type: MediaType.MOVIE,
      title: opts.title,
      overview: opts.overview,
      posterUrl: POSTER(seed),
      backdropUrl: BACKDROP(seed),
      rating: 7 + Math.random(),
      popularity: 50,
      externalIds: opts.tmdb ? { create: [{ provider: ExternalProvider.TMDB, value: String(opts.tmdb) }] } : undefined,
      genres: { create: genres.map((g) => ({ genreId: g.id })) },
      providers: { create: providers.map((p) => ({ providerId: p.id })) },
      movie: { create: { releaseYear: opts.releaseYear, runtimeMinutes: opts.runtime, releaseDate: new Date(opts.releaseYear, 5, 15) } },
    },
    update: {},
  });
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.log('Skipping content seed in production');
    return;
  }
  console.log('Seeding…');

  const demo = await prisma.user.upsert({
    where: { email: 'demo@tvwatch.app' },
    create: {
      email: 'demo@tvwatch.app',
      username: 'demo',
      passwordHash: await argon2.hash('password'),
      emailVerified: true,
      authProviders: { create: { provider: 'EMAIL', providerUid: 'demo@tvwatch.app' } },
      profile: {
        create: {
          displayName: 'Demo User',
          bio: 'Just here tracking my shows.',
          avatarUrl: POSTER('demo-avatar'),
          coverUrl: BACKDROP('demo-cover'),
        },
      },
    },
    update: {},
  });

  const breaker = await makeShow({
    title: 'Quantum Horizon',
    overview: 'A team of scientists explore parallel dimensions to save a collapsing universe.',
    network: 'NovaStream',
    genreNames: ['Sci-Fi', 'Drama'],
    providerNames: ['NovaStream', 'FlixPlus'],
    tmdb: 1,
    seasons: [
      {
        title: 'Season 1',
        episodes: [
          { title: 'The Fracture', airedDaysAgo: 20 },
          { title: 'Echoes', airedDaysAgo: 13 },
          { title: 'Drift', airedDaysAgo: 6 },
          { title: 'Threshold', airsInDays: 1 },
          { title: 'Convergence', airsInDays: 8 },
        ],
      },
      {
        title: 'Season 2',
        episodes: [{ title: 'Rebirth', airsInDays: 14 }],
      },
    ],
  });

  const nightfall = await makeShow({
    title: 'Nightfall Precinct',
    overview: 'Detectives work the strangest cases in a city that never sleeps.',
    network: 'CrimeNet',
    genreNames: ['Crime', 'Thriller'],
    providerNames: ['CrimeNet'],
    tmdb: 2,
    seasons: [
      {
        title: 'Season 1',
        episodes: [
          { title: 'First Shift', airedDaysAgo: 40 },
          { title: 'Cold Case', airedDaysAgo: 35 },
          { title: 'Undercover', airedDaysAgo: 33 },
        ],
      },
    ],
  });

  const harbor = await makeShow({
    title: 'Harbor Lights',
    overview: 'Life, love and ambition in a bustling coastal town.',
    network: 'DramaLife',
    genreNames: ['Drama', 'Romance'],
    providerNames: ['DramaLife'],
    seasons: [{ title: 'Season 1', episodes: [{ title: 'Pilot', airedDaysAgo: 60 }, { title: 'Tides', airedDaysAgo: 2 }] }],
  });

  await makeShow({
    title: 'Pixel Gladiators',
    overview: 'Esports rivals team up to conquer the world championship.',
    network: 'GameTV',
    genreNames: ['Comedy', 'Sport'],
    providerNames: ['GameTV'],
    seasons: [{ title: 'Season 1', episodes: [{ title: 'GG', airsInDays: 3 }, { title: 'Ranked', airsInDays: 10 }] }],
  });

  const m1 = await makeMovie({ title: 'Silent Orbit', overview: 'An astronaut stranded on a derelict station fights to return home.', genreNames: ['Sci-Fi', 'Thriller'], providerNames: ['FlixPlus'], releaseYear: 2023, runtime: 124, tmdb: 101 });
  const m2 = await makeMovie({ title: 'The Last Bakery', overview: 'A family bakery holds a neighborhood together.', genreNames: ['Drama', 'Comedy'], providerNames: ['DramaLife'], releaseYear: 2022, runtime: 98, tmdb: 102 });
  await makeMovie({ title: 'Neon Requiem', overview: 'A hacker uncovers a conspiracy in a rain-soaked megacity.', genreNames: ['Action', 'Sci-Fi'], providerNames: ['NovaStream'], releaseYear: 2024, runtime: 132, tmdb: 103 });
  await makeMovie({ title: 'Mountain Heart', overview: 'A climber confronts grief on the world\u2019s toughest peak.', genreNames: ['Adventure', 'Drama'], providerNames: ['FlixPlus'], releaseYear: 2021, runtime: 110, tmdb: 104 });

  // demo watch history + watchlist + favorites
  const breakerEps = await prisma.episode.findMany({ where: { season: { show: { mediaId: breaker.id } } }, orderBy: { number: 'asc' } });
  const nightfallEps = await prisma.episode.findMany({ where: { season: { show: { mediaId: nightfall.id } } } });
  for (const e of breakerEps.slice(0, 3)) {
    await prisma.userEpisodeStatus.upsert({
      where: { userId_episodeId: { userId: demo.id, episodeId: e.id } },
      create: { userId: demo.id, episodeId: e.id, watched: true, watchedAt: new Date(Date.now() - 6 * 86400000) },
      update: {},
    });
    await prisma.watchHistory.create({
      data: { userId: demo.id, mediaId: breaker.id, mediaType: MediaType.SHOW, episodeId: e.id, seasonNumber: e.seasonId ? 1 : 1, episodeNumber: e.number, runtimeMinutes: 45, watchedAt: new Date(Date.now() - 6 * 86400000) },
    }).catch(() => undefined);
  }
  await prisma.userShowStatus.upsert({
    where: { userId_mediaId: { userId: demo.id, mediaId: breaker.id } },
    create: { userId: demo.id, mediaId: breaker.id, watchedCount: 3, totalCount: breakerEps.length, lastWatchedAt: new Date(Date.now() - 6 * 86400000) },
    update: { watchedCount: 3, totalCount: breakerEps.length },
  });
  await prisma.userShowStatus.upsert({
    where: { userId_mediaId: { userId: demo.id, mediaId: nightfall.id } },
    create: { userId: demo.id, mediaId: nightfall.id, watchedCount: 0, totalCount: nightfallEps.length, lastWatchedAt: new Date(Date.now() - 40 * 86400000) },
    update: {},
  });

  await prisma.watchlistItem.upsert({ where: { userId_mediaId: { userId: demo.id, mediaId: harbor.id } }, create: { userId: demo.id, mediaId: harbor.id }, update: {} });
  await prisma.favorite.upsert({ where: { userId_mediaId: { userId: demo.id, mediaId: breaker.id } }, create: { userId: demo.id, mediaId: breaker.id }, update: {} });

  await prisma.userMovieStatus.upsert({ where: { userId_mediaId: { userId: demo.id, mediaId: m1.id } }, create: { userId: demo.id, mediaId: m1.id, watched: true, watchedAt: new Date(Date.now() - 3 * 86400000) }, update: {} });
  await prisma.watchHistory.create({ data: { userId: demo.id, mediaId: m1.id, mediaType: MediaType.MOVIE, runtimeMinutes: 124, watchedAt: new Date(Date.now() - 3 * 86400000) } }).catch(() => undefined);
  await prisma.watchlistItem.upsert({ where: { userId_mediaId: { userId: demo.id, mediaId: m2.id } }, create: { userId: demo.id, mediaId: m2.id }, update: {} });

  console.log('Seed complete. Demo login: demo@tvwatch.app / password');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
