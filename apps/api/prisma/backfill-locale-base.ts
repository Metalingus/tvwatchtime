import { PrismaClient } from '@prisma/client';

/**
 * One-off repair for locale base contamination (shows/movies + seasons/episodes).
 *
 * Repairs rows whose base title equals a non-English override (the contamination
 * signature from the brief first localization iteration), re-fetching the trusted
 * English base from TMDb and writing base + `['en']` overrides while preserving
 * every other locale.
 *
 * Improvements over the first pass:
 *  - Only processes rows that don't yet have an `['en']` override → re-running only
 *    retries the previously-skipped ones (idempotent, no wasted calls).
 *  - Retries transient TMDb errors (429 / 5xx) with exponential backoff.
 *  - Logs WHY each row is skipped (no TMDB id vs HTTP status) so you can see what
 *    remains.
 *
 * Run remote: `docker compose ... run --rm api pnpm --filter @tvwatch/api db:backfill-locale-base`
 */
const TMDB_KEY = process.env.TMDB_API_KEY;
const TMDB = 'https://api.themoviedb.org/3';
const IMG = (p?: string | null, s = 'w342') => (p ? `https://image.tmdb.org/t/p/${s}${p}` : null);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch JSON with retry/backoff on 429 and 5xx. Throws {status} on final failure. */
async function tmdbGet(path: string): Promise<any> {
  const url = `${TMDB}${path}?api_key=${TMDB_KEY}&language=en-US`;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    lastStatus = res.status;
    // 404 (stale id) / 401 (bad key) are not transient — stop immediately.
    if (res.status === 404 || res.status === 401) break;
    // 429 / 5xx: back off and retry.
    const retryAfter = Number(res.headers.get('retry-after') || '') || 2 * (attempt + 1);
    await sleep(Math.min(retryAfter, 10) * 1000);
  }
  const err: any = new Error(`tmdb ${lastStatus}`);
  err.status = lastStatus;
  throw err;
}

async function enMediaBase(type: 'SHOW' | 'MOVIE', tmdbId: number) {
  const path = type === 'SHOW' ? `/tv/${tmdbId}` : `/movie/${tmdbId}`;
  const j = await tmdbGet(path);
  return {
    title: j.name || j.title || '',
    overview: (j.overview ?? null) as string | null,
    posterUrl: IMG(j.poster_path) as string | null,
    backdropUrl: IMG(j.backdrop_path, 'w780') as string | null,
  };
}

async function enSeason(tmdbId: number, season: number) {
  const j = await tmdbGet(`/tv/${tmdbId}/season/${season}`);
  return {
    name: j.name || '',
    overview: (j.overview ?? null) as string | null,
    posterUrl: IMG(j.poster_path) as string | null,
    episodes: (j.episodes || []).map((e: any) => ({
      number: e.episode_number as number,
      name: e.name || '',
      overview: (e.overview ?? null) as string | null,
      stillUrl: IMG(e.still_path, 'w300') as string | null,
    })),
  };
}

function setEn(map: unknown, val: string | null): Record<string, string> {
  const m = map && typeof map === 'object' ? { ...(map as Record<string, string>) } : {};
  if (val != null && val !== '') m['en'] = val;
  return m;
}

async function main() {
  if (!TMDB_KEY) {
    console.warn('TMDB_API_KEY not set — nothing to do.');
    return;
  }
  const prisma = new PrismaClient();
  const skipReasons = new Map<string, number>();
  const note = (reason: string) => skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  try {
    let fixed = 0;

    // ---- 1. Contaminated media items without an English override yet ----
    const mediaRows = await prisma.$queryRaw<
      Array<{ id: string; type: string; tmdb: string | null }>
    >`
      SELECT m.id, m.type::text AS type,
        (SELECT e.value FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB' LIMIT 1) AS tmdb
      FROM media_items m
      WHERE m.titles IS NOT NULL
        AND (m.titles->>'en') IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(m.titles) kv WHERE kv.key <> 'en' AND kv.value = m.title)
    `;
    console.log(`media_items to repair: ${mediaRows.length}`);
    for (const row of mediaRows) {
      if (!row.tmdb) {
        note('media: no TMDB id');
        continue;
      }
      try {
        const en = await enMediaBase(row.type as 'SHOW' | 'MOVIE', Number(row.tmdb));
        const cur = await prisma.mediaItem.findUnique({
          where: { id: row.id },
          select: { titles: true, overviews: true, posterUrls: true, backdropUrls: true },
        });
        await prisma.mediaItem.update({
          where: { id: row.id },
          data: {
            title: en.title,
            overview: en.overview,
            posterUrl: en.posterUrl,
            backdropUrl: en.backdropUrl,
            titleLocale: 'en',
            titles: setEn(cur?.titles, en.title),
            overviews: setEn(cur?.overviews, en.overview),
            posterUrls: setEn(cur?.posterUrls, en.posterUrl),
            backdropUrls: setEn(cur?.backdropUrls, en.backdropUrl),
          },
        });
        fixed++;
        await sleep(250); // ~4 req/s — gentle on TMDb
      } catch (e: any) {
        note(`media: tmdb ${e.status ?? 'error'}`);
      }
    }

    // ---- 2. Contaminated seasons (+ episodes) without an English override yet ----
    const seasonIds = (
      await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s.id FROM seasons s
      WHERE s.titles IS NOT NULL
        AND (s.titles->>'en') IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_each_text(s.titles) kv WHERE kv.key <> 'en' AND kv.value = s.title)
    `
    ).map((r) => r.id);
    console.log(`seasons to repair: ${seasonIds.length}`);

    const seasons = await prisma.season.findMany({
      where: { id: { in: seasonIds } },
      select: {
        id: true,
        number: true,
        titles: true,
        overviews: true,
        posterUrls: true,
        episodes: { select: { id: true, number: true, titles: true, overviews: true, stillUrls: true } },
        show: { select: { media: { select: { externalIds: { select: { provider: true, value: true } } } } } },
      },
    });

    let seasonFixed = 0;
    let episodeFixed = 0;
    for (const season of seasons) {
      const tmdb = season.show.media.externalIds.find((e) => e.provider === 'TMDB')?.value;
      if (!tmdb) {
        note('season: no TMDB id');
        continue;
      }
      try {
        const en = await enSeason(Number(tmdb), season.number);
        await prisma.season.update({
          where: { id: season.id },
          data: {
            title: en.name,
            overview: en.overview,
            posterUrl: en.posterUrl,
            titles: setEn(season.titles, en.name),
            overviews: setEn(season.overviews, en.overview),
            posterUrls: setEn(season.posterUrls, en.posterUrl),
          },
        });
        seasonFixed++;
        for (const ep of season.episodes) {
          const enEp = en.episodes.find((x) => x.number === ep.number);
          if (!enEp) continue;
          await prisma.episode.update({
            where: { id: ep.id },
            data: {
              title: enEp.name,
              overview: enEp.overview,
              stillUrl: enEp.stillUrl,
              titles: setEn(ep.titles, enEp.name),
              overviews: setEn(ep.overviews, enEp.overview),
              stillUrls: setEn(ep.stillUrls, enEp.stillUrl),
            },
          });
          episodeFixed++;
        }
        await sleep(250);
      } catch (e: any) {
        note(`season: tmdb ${e.status ?? 'error'}`);
      }
    }

    console.log(
      `\nmedia repaired: ${fixed} | seasons repaired: ${seasonFixed} | episodes repaired: ${episodeFixed}`,
    );
    console.log('skip reasons:', Object.fromEntries(skipReasons));
    if ([...skipReasons.values()].some((n) => n > 0)) {
      console.log(
        'Re-run this command to retry the skipped rows (already-repaired rows are skipped automatically).',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
