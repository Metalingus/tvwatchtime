// Field/mapping tests use a fake database. Transaction-lock races run against PostgreSQL separately.
jest.mock('./util/identity-write-fence', () => ({
  ...jest.requireActual('./util/identity-write-fence'),
  fenceIdentityWrite: jest.fn().mockResolvedValue(undefined),
  fenceMetadataWrite: jest.fn().mockResolvedValue(undefined),
  fenceEpisodeRepair: jest.fn().mockResolvedValue(undefined),
}));
function withMetadataTransaction<T>(prisma: T): T {
  const p = prisma as any;
  if (!p.$transaction)
    p.$transaction = jest.fn(async (work: any) =>
      typeof work === 'function' ? work(p) : Promise.all(work),
    );
  return prisma;
}
import { ExternalProvider, MediaType } from '@tvwatch/shared';
import { MediaMetadataService } from './media-metadata.service';
import { runInLanguage } from '../common/language.context';

/**
 * Focused spec for locale parking + fully-aired season skipping:
 *  - isLocaleFetchParked: a recent localeUnavailable stamp parks the locale for 7 days.
 *  - ensureShowFull stale path: when the English payload's translations map proves the
 *    provider lacks the request locale, the localized fetch is skipped and the locale
 *    is stamped via prisma.$executeRaw (atomic jsonb merge).
 *  - Fresh-base path: a parked locale skips the localized fetch entirely; a provably
 *    missing translation on the fetched payload is stamped WITHOUT storing overrides.
 *  - airedSeasonSkipper: on re-hydration, complete fully-aired old seasons are skipped
 *    and filtered out of the payload before persistShow (syncSeasons never touches them).
 */

const DAY_MS = 1000 * 60 * 60 * 24;

function makeShow(over: Record<string, any> = {}) {
  return {
    type: MediaType.SHOW,
    tmdbId: 65942,
    title: 'Sonic Boom',
    overview: null,
    posterUrl: null,
    backdropUrl: null,
    status: 'ENDED',
    yearStart: 2014,
    yearEnd: 2017,
    network: null,
    runtimeMinutes: 11,
    rating: 7,
    popularity: 10,
    trailerUrl: null,
    seasonsCount: 1,
    episodesCount: 1,
    inProduction: false,
    genres: [{ name: 'Animation' }],
    externals: [{ provider: ExternalProvider.TMDB, value: '65942' }],
    keywords: [],
    cast: [],
    providers: [],
    nextAirDate: null,
    seasons: [
      {
        number: 1,
        title: 'Season 1',
        overview: null,
        posterUrl: null,
        episodeCount: 1,
        isSpecial: false,
        episodes: [
          {
            number: 1,
            title: 'E1',
            overview: null,
            stillUrl: null,
            runtimeMinutes: 11,
            airDate: '2014-11-08',
            rating: 7,
            isFinale: false,
            tmdbId: 9001,
          },
        ],
      },
    ],
    ...over,
  } as any;
}

function fakeTx(over: Record<string, any> = {}) {
  const calls = {
    mediaItemUpdate: [] as any[],
    mediaItemCreate: [] as any[],
    seasonUpsert: [] as any[],
    seasonUpdate: [] as any[],
  };
  const tx: any = {
    mediaItem: {
      findUnique: async () => over.prev ?? null,
      create: async (a: any) => {
        calls.mediaItemCreate.push(a);
        return { id: 'new-row' };
      },
      update: async (a: any) => {
        calls.mediaItemUpdate.push(a);
        return {};
      },
    },
    externalId: { upsert: async () => ({}), findFirst: async () => null },
    show: {
      upsert: async () => ({}),
      findUnique: async () => ({ id: 'show-1' }),
    },
    genre: {
      findUnique: async () => null,
      upsert: async (a: any) => ({ id: `g-${a.where.slug}` }),
    },
    watchProvider: { upsert: async () => ({ id: 'p-1' }) },
    castMember: { upsert: async () => ({ id: 'c-1' }) },
    mediaGenre: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaWatchProvider: { deleteMany: async () => ({}), createMany: async () => ({}) },
    mediaCast: {
      findMany: async () => [],
      deleteMany: async () => ({}),
      createMany: async () => ({}),
      create: async () => ({}),
    },
    season: {
      findMany: async () => over.txSeasons ?? [],
      findUnique: async () => null,
      upsert: async (a: any) => {
        calls.seasonUpsert.push(a);
        return { id: 'se-1' };
      },
      update: async (a: any) => {
        calls.seasonUpdate.push(a);
        return {};
      },
    },
    episode: {
      create: async () => ({ id: 'ep-1' }),
      update: async (a: any) => ({ id: a.where.id }),
    },
    episodeExternalId: { upsert: async () => ({}) },
    movie: { findUnique: async () => null, upsert: async () => ({}) },
  };
  return { tx, calls };
}

function makeTmdbService(opts: {
  tx: any;
  getShow: jest.Mock;
  existing?: any; // media row returned by the external-id lookup (null = new media)
  storedSeasons?: any[]; // rows for airedSeasonSkipper's prisma.season.findMany
}) {
  const executeRaw = jest.fn(async (..._args: any[]) => 1);
  const transaction = jest.fn(async (fn: any) => fn(opts.tx));
  const prisma = {
    $transaction: transaction,
    $executeRaw: executeRaw,
    mediaItem: { findUnique: async () => ({ metadataRefreshedAt: new Date() }) },
    externalId: {
      findFirst: jest.fn(async () => (opts.existing ? { media: opts.existing } : null)),
    },
    season: { findMany: jest.fn(async () => opts.storedSeasons ?? []) },
    show: { findUnique: async () => ({ id: 'show-1' }) }, // syncSeasons root lookup
  };
  const svc = new MediaMetadataService(
    withMetadataTransaction(prisma as any),
    { enabled: true, getShow: opts.getShow } as any, // tmdb provider
    {} as any, // tvdb
    {} as any, // tvmaze (disabled → enrichAirtimes no-ops)
    {} as any, // config
    { enqueueClassifyCandidate: async () => undefined } as any,
    { get: async () => null, set: async () => undefined, del: async () => undefined } as any,
  );
  return { svc, executeRaw, transaction };
}

const staleShow = (metadataProvenance: any = null) => ({
  id: 'show-1',
  type: 'SHOW',
  metadataRefreshedAt: new Date(Date.now() - 2 * DAY_MS), // stale → full re-hydration
  metadataProvenance,
});

const freshShow = (metadataProvenance: any = null) => ({
  id: 'show-1',
  type: 'SHOW',
  metadataRefreshedAt: new Date(), // fresh → locale-override path only
  metadataProvenance,
});

describe('MediaMetadataService — isLocaleFetchParked', () => {
  const svc = new MediaMetadataService(
    withMetadataTransaction({} as any),
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

  it('parks a locale stamped moments ago', () => {
    const provenance = { localeUnavailable: { it: new Date().toISOString() } };
    expect(svc.isLocaleFetchParked(provenance, 'it')).toBe(true);
  });

  it('does not park a locale stamped more than 7 days ago', () => {
    const provenance = {
      localeUnavailable: { it: new Date(Date.now() - 8 * DAY_MS).toISOString() },
    };
    expect(svc.isLocaleFetchParked(provenance, 'it')).toBe(false);
  });

  it('never parks on missing or garbage provenance', () => {
    expect(svc.isLocaleFetchParked(null, 'it')).toBe(false);
    expect(svc.isLocaleFetchParked(undefined, 'it')).toBe(false);
    expect(svc.isLocaleFetchParked({}, 'it')).toBe(false);
    expect(svc.isLocaleFetchParked({ localeUnavailable: 'junk' }, 'it')).toBe(false);
    expect(svc.isLocaleFetchParked({ localeUnavailable: { it: 'not-a-date' } }, 'it')).toBe(false);
    expect(svc.isLocaleFetchParked({ localeUnavailable: { it: 123 } }, 'it')).toBe(false);
    // A stamp for a DIFFERENT locale does not park this one.
    expect(
      svc.isLocaleFetchParked({ localeUnavailable: { fr: new Date().toISOString() } }, 'it'),
    ).toBe(false);
  });
});

describe('MediaMetadataService — locale parking on ensureShowFull', () => {
  it('stale path: translations map lacks the locale → no localized fetch, locale stamped', async () => {
    const { tx } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({ translations: { fr: { title: 'Sonic Boom FR', overview: 'aperçu' } } }),
    );
    const { svc, executeRaw, transaction } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow(),
      storedSeasons: [],
    });

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    // ONE English call only — the Italian fetch was provably useless.
    expect(getShow).toHaveBeenCalledTimes(1);
    expect(getShow.mock.calls[0][1]).toBe('en-US');
    // Stamped via the atomic jsonb merge ($executeRaw template: [strings, lang, isoDate, mediaId]).
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0][1]).toBe('it');
    expect(executeRaw.mock.calls[0][3]).toBe('show-1');
    // persistShow core tx + one per-season tx (fixture has 1 season) — applyLocaleOverrides never ran.
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it('stale path: translations map covers the locale → localized fetch still happens', async () => {
    const { tx } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    const getShow = jest.fn(async (_id: number, lang?: string) =>
      lang === 'it'
        ? makeShow({ title: 'Sonic Boom IT', seasons: [] })
        : makeShow({ translations: { it: { title: 'Sonic Boom IT', overview: 'panoramica' } } }),
    );
    const { svc, executeRaw, transaction } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow(),
      storedSeasons: [],
    });

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    expect(getShow.mock.calls.map((c) => c[1])).toEqual(['en-US', 'it']);
    // Covered locale → no parking stamp…
    expect(executeRaw).not.toHaveBeenCalled();
    // …and applyLocaleOverrides ran (third transaction: persistShow core + 1 season tx + overrides).
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('stale path: already-parked locale → neither the fetch nor a re-stamp', async () => {
    const { tx } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({ translations: undefined }),
    );
    const { svc, executeRaw, transaction } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow({ localeUnavailable: { it: new Date().toISOString() } }),
      storedSeasons: [],
    });

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    expect(getShow).toHaveBeenCalledTimes(1); // English base only
    expect(executeRaw).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2); // persistShow core + one per-season tx
  });

  it('fresh base: parked locale skips the localized fetch entirely', async () => {
    const { tx } = fakeTx();
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) => makeShow());
    const { svc, executeRaw, transaction } = makeTmdbService({
      tx,
      getShow,
      existing: freshShow({ localeUnavailable: { it: new Date().toISOString() } }),
    });

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    expect(getShow).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fresh base: fetched payload provably lacks the locale → stamped, overrides not stored', async () => {
    const { tx, calls } = fakeTx();
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({ translations: { fr: { title: 'Sonic Boom FR' } } }),
    );
    const { svc, executeRaw, transaction } = makeTmdbService({
      tx,
      getShow,
      existing: freshShow(),
    });

    await runInLanguage('it', () => svc.ensureShowFull(65942));

    // With no base translations map the only way to know is to fetch once…
    expect(getShow).toHaveBeenCalledTimes(1);
    expect(getShow.mock.calls[0][1]).toBe('it');
    // …then park it (no read-modify-write of the whole row) WITHOUT storing overrides.
    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls[0][1]).toBe('it');
    expect(executeRaw.mock.calls[0][3]).toBe('show-1');
    expect(transaction).not.toHaveBeenCalled();
    expect(calls.mediaItemUpdate).toHaveLength(0);
  });
});

describe('MediaMetadataService — fully-aired season skipping on re-hydration', () => {
  const oldAirDate = new Date(Date.now() - 30 * DAY_MS);
  const storedCompleteSeason = {
    number: 14, // beyond the 0..12 append window → would need an individual fetch
    episodeCount: 10,
    episodes: Array.from({ length: 10 }, () => ({ airDate: oldAirDate })),
  };

  it('skips the stored complete fully-aired season and filters it out before persistShow', async () => {
    const { tx, calls } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    // The provider-side skip leaves the covered season episode-less (see tmdb.provider.spec).
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({
        seasons: [
          ...makeShow().seasons, // season 1 with episodes
          { number: 14, title: 'Season 14', episodeCount: 10, isSpecial: false, episodes: [] },
        ],
      }),
    );
    const { svc } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow(),
      storedSeasons: [storedCompleteSeason],
    });

    await runInLanguage('en', () =>
      svc.ensureShowFull(65942, undefined, { skipAiredSeasons: true }),
    );

    // The predicate went to BOTH the base and (potential) locale getShow calls.
    const skip = getShow.mock.calls[0][2]?.skipSeasonDetail;
    expect(typeof skip).toBe('function');
    expect(skip(14, 10)).toBe(true); // stored complete + fully aired > 7 days
    expect(skip(14, 11)).toBe(false); // provider count changed → refetch
    expect(skip(0, 10)).toBe(false); // specials are never skipped
    expect(skip(3, 8)).toBe(false); // not stored → refetch

    // filterSkippedSeasons dropped season 14: syncSeasons only upserted season 1.
    expect(calls.seasonUpsert).toHaveLength(1);
    expect(calls.seasonUpsert[0].create.number).toBe(1);
  });

  it('never skips by default — background paths (repairs, changes sync, backfill) get full structure', async () => {
    const { tx, calls } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({
        seasons: [
          ...makeShow().seasons,
          { number: 14, title: 'Season 14', episodeCount: 10, isSpecial: false, episodes: [] },
        ],
      }),
    );
    const { svc } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow(),
      storedSeasons: [storedCompleteSeason],
    });

    await runInLanguage('en', () => svc.ensureShowFull(65942));

    // No predicate passed to the provider and no filtering: the full payload reaches syncSeasons.
    expect(getShow.mock.calls[0][2]?.skipSeasonDetail).toBeUndefined();
    expect(calls.seasonUpsert.map((u) => u.create.number)).toContain(14);
  });

  it('does not skip a season whose latest episode aired within the 7-day buffer', async () => {
    const { tx, calls } = fakeTx({
      prev: { type: 'SHOW', titles: null, overviews: null, posterUrls: null, backdropUrls: null },
    });
    const getShow = jest.fn(async (_id?: number, _lang?: string, _opts?: any) =>
      makeShow({
        seasons: [
          ...makeShow().seasons,
          { number: 14, title: 'Season 14', episodeCount: 10, isSpecial: false, episodes: [] },
        ],
      }),
    );
    const { svc } = makeTmdbService({
      tx,
      getShow,
      existing: staleShow(),
      storedSeasons: [
        {
          ...storedCompleteSeason,
          episodes: [...storedCompleteSeason.episodes, { airDate: new Date() }], // aired today
        },
      ],
    });

    await runInLanguage('en', () =>
      svc.ensureShowFull(65942, undefined, { skipAiredSeasons: true }),
    );

    const skip = getShow.mock.calls[0][2]?.skipSeasonDetail;
    expect(skip(14, 10)).toBe(false);
    // Not skippable → not filtered either: syncSeasons still sees the season…
    expect(calls.seasonUpsert.map((u) => u.create.number)).toContain(14);
  });
});
