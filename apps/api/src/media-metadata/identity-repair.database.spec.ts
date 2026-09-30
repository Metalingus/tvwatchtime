import { PrismaClient, Prisma, MediaType } from '@prisma/client';
import { randomUUID } from 'crypto';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { StructureRemapService } from './structure-remap.service';
import { canonicalEpisodeAliasTargets } from './util/episode-identity';
import { canonicalMediaId } from './util/canonical-media';

// Explicit opt-in only. Fixtures run in one outer transaction which ALWAYS rolls back.
const url = process.env.WATCHFORGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('WatchForge transactional preservation (local rollback fixtures)', () => {
  let db: PrismaClient;
  beforeAll(() => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1'].includes(target.hostname))
      throw new Error('Local database required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  async function fixture(
    run: (tx: Prisma.TransactionClient, service: MediaCanonicalizationService) => Promise<void>,
  ) {
    const rollback = new Error('ROLLBACK_FIXTURE');
    try {
      await db.$transaction(
        async (tx) => {
          const prisma = new Proxy(tx, {
            get: (obj, key) =>
              key === '$transaction' ? async (fn: any) => fn(tx) : (obj as any)[key],
          });
          const redis = {
            del: async () => {},
            delByPattern: async () => 0,
            client: { incr: async () => 1 },
          };
          const remap = new StructureRemapService(prisma as any, redis as any);
          const service = new MediaCanonicalizationService(
            prisma as any,
            {} as any,
            redis as any,
            { emit: () => {} } as any,
            remap,
          );
          await run(tx, service);
          throw rollback;
        },
        { timeout: 60000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }
  async function seed(tx: Prisma.TransactionClient, type: MediaType = 'MOVIE') {
    const key = randomUUID();
    const user = await tx.user.create({
      data: { email: key + '@identity.invalid', username: key },
    });
    const source = await tx.mediaItem.create({
      data: {
        type,
        title: 'Identity fixture source',
        ...(type === 'MOVIE'
          ? { movie: { create: { releaseYear: 2001 } } }
          : { show: { create: { yearStart: 2001 } } }),
      },
    });
    const target = await tx.mediaItem.create({
      data: {
        type,
        title: 'Identity fixture target',
        ...(type === 'MOVIE'
          ? { movie: { create: { releaseYear: 2001 } } }
          : { show: { create: { yearStart: 2001 } } }),
      },
    });
    const ids = [
      {
        provider: 'TMDB' as const,
        providerEntityKind: type === 'MOVIE' ? ('MOVIE' as const) : ('SERIES' as const),
        value: key + '-tmdb',
      },
      {
        provider: 'THE_TVDB' as const,
        providerEntityKind: type === 'MOVIE' ? ('MOVIE' as const) : ('SERIES' as const),
        value: key + '-tvdb',
      },
    ];
    await tx.externalId.create({ data: { ...ids[0], mediaId: target.id } });
    await tx.externalId.create({ data: { ...ids[1], mediaId: source.id } });
    return { user, source, target, ids };
  }

  it('persists a same-show episode split and its source ownership before deleting the old row', async () => {
    await fixture(async (tx, service) => {
      const { user, source } = await seed(tx, 'SHOW');
      const show = await tx.show.findUniqueOrThrow({ where: { mediaId: source.id } });
      const season = await tx.season.create({
        data: { showId: show.id, number: 1, title: 'Season 1' },
      });
      const make = (number: number, runtime: number) =>
        tx.episode.create({
          data: { seasonId: season.id, number, title: 'Story ' + number, runtimeMinutes: runtime },
        });
      const old = await make(10, 60),
        a = await make(1, 30),
        b = await make(2, 30),
        alias = randomUUID();
      await tx.episodeExternalId.create({
        data: {
          episodeId: old.id,
          provider: 'THE_TVDB',
          providerEntityKind: 'EPISODE',
          value: alias,
        },
      });
      await tx.userEpisodeStatus.create({
        data: {
          userId: user.id,
          episodeId: old.id,
          watched: true,
          source: 'TRAKT',
          sourceKey: 'source-watch',
        },
      });
      await tx.watchHistory.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          mediaType: 'SHOW',
          episodeId: old.id,
          watchedAt: new Date(),
          runtimeMinutes: 60,
          source: 'TRAKT',
          sourceKey: 'source-watch',
        },
      });
      const remap = new StructureRemapService((service as any).prisma);
      const row = (e: any) => ({
        ...e,
        seasonNumber: 1,
        isSpecial: false,
        tmdbValues: [],
        tvdbValues: e.id === old.id ? [alias] : [],
      });
      await (remap as any).transferSplit(row(old), [row(a), row(b)], new Set());
      expect(await tx.episode.findUnique({ where: { id: old.id } })).toBeNull();
      expect((await canonicalEpisodeAliasTargets(tx, 'THE_TVDB', alias)).sort()).toEqual(
        [a.id, b.id].sort(),
      );
      const histories = await tx.watchHistory.findMany({ where: { userId: user.id } });
      expect(histories).toHaveLength(2);
      expect(
        histories.every(
          (h) => h.source === 'TRAKT' && h.sourceKey === 'source-watch' && h.runtimeMinutes === 30,
        ),
      ).toBe(true);
      const statuses = await tx.userEpisodeStatus.findMany({ where: { userId: user.id } });
      expect(statuses.every((s) => s.source === 'TRAKT' && s.sourceKey === 'source-watch')).toBe(
        true,
      );
    });
  });

  it('quarantines empty legacy placeholders but refuses a concurrent protected-data addition', async () => {
    await fixture(async (tx, service) => {
      const { user, source, ids } = await seed(tx);
      const show = await tx.show.create({ data: { mediaId: source.id } });
      const season = await tx.season.create({
        data: { showId: show.id, number: 1, title: 'Season 1' },
      });
      const good = await tx.episode.create({
        data: {
          seasonId: season.id,
          number: 1,
          title: 'The Interview',
          runtimeMinutes: 30,
          airDate: new Date('2020-01-01'),
        },
      });
      const placeholder = await tx.episode.create({
        data: { seasonId: season.id, number: 2, title: 'Episode 2' },
      });
      await tx.userEpisodeStatus.create({
        data: { userId: user.id, episodeId: good.id, watched: true },
      });
      const options = {
        mode: 'dry-run' as const,
        type: 'SHOW' as const,
        title: 'Verified show',
        independentParentAnchor: true,
        verifiedIds: [{ ...ids[1], providerEntityKind: 'SERIES' }],
        removeAliasIds: [],
        allowedCastIds: [],
        canonical: 'tmdb' as const,
        snapshot: [
          {
            number: 1,
            isSpecial: false,
            episodes: [
              {
                tmdbId: 1,
                number: 1,
                title: 'The Interview',
                runtimeMinutes: 30,
                airDate: '2020-01-01',
              },
            ],
          },
        ] as any,
      };
      const preview = await service.splitIdentity(source.id, options);
      expect(preview).toMatchObject({ status: 'ready', quarantinedMetadataRows: 1 });
      const arrived = await tx.userEpisodeStatus.create({
        data: { userId: user.id, episodeId: placeholder.id, watched: true },
      });
      await expect(
        service.splitIdentity(source.id, {
          ...options,
          mode: 'repair',
          fingerprint: preview.fingerprint,
        }),
      ).resolves.toMatchObject({ status: 'blocked' });
      await tx.userEpisodeStatus.delete({ where: { id: arrived.id } });
      const result = await service.splitIdentity(source.id, {
        ...options,
        mode: 'repair',
        fingerprint: preview.fingerprint,
      });
      expect(result.status).toBe('applied');
      expect(await tx.episode.findUnique({ where: { id: placeholder.id } })).toMatchObject({
        structureState: 'LEGACY_UNMAPPED',
      });
      expect(await tx.userEpisodeStatus.findFirst({ where: { episodeId: good.id } })).toMatchObject(
        { watched: true },
      );
    });
  });

  it('keeps the source and history, protects manual ratings, and preserves any-provider alerts', async () => {
    await fixture(async (tx, service) => {
      const { user, source, target, ids } = await seed(tx);
      await tx.userMovieStatus.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          watched: true,
          watchCount: 3,
          source: 'TVTIME',
        },
      });
      await tx.watchHistory.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          mediaType: 'MOVIE',
          watchedAt: new Date('2020-01-01'),
          source: 'TVTIME',
          sourceKey: 'history',
        },
      });
      await tx.rating.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          rating: 2,
          source: 'TVTIME',
          createdAt: new Date('2026-01-01'),
        },
      });
      await tx.rating.create({
        data: {
          userId: user.id,
          mediaId: target.id,
          rating: 9,
          source: 'MANUAL',
          createdAt: new Date('2020-01-01'),
        },
      });
      await tx.watchProviderAlert.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          offerType: 'STREAM',
          country: 'CA',
          providerIds: [],
        },
      });
      await tx.watchProviderAlert.create({
        data: {
          userId: user.id,
          mediaId: target.id,
          offerType: 'STREAM',
          country: 'CA',
          providerIds: [8],
        },
      });
      const preview = await service.identityFamily([source.id, target.id], target.id, {
        mode: 'dry-run',
        verifiedIds: ids,
      });
      expect(preview.status).toBe('ready');
      const result = await service.identityFamily([source.id, target.id], target.id, {
        mode: 'repair',
        verifiedIds: ids,
        fingerprint: preview.fingerprint,
      });
      expect(result.activated).toBe(1);
      expect(await tx.mediaItem.count({ where: { id: source.id } })).toBe(1);
      expect(await canonicalMediaId(tx, source.id)).toBe(target.id);
      expect(
        await tx.rating.findUnique({
          where: { userId_mediaId: { userId: user.id, mediaId: target.id } },
        }),
      ).toMatchObject({ rating: 9, source: 'MANUAL' });
      expect(
        await tx.watchHistory.count({
          where: { userId: user.id, mediaId: target.id, source: 'TVTIME' },
        }),
      ).toBe(1);
      expect(
        await tx.watchProviderAlert.findFirst({ where: { mediaId: target.id } }),
      ).toMatchObject({ providerIds: [] });
      expect(await tx.userMovieStatus.findFirst({ where: { mediaId: target.id } })).toMatchObject({
        watchCount: 3,
      });
    });
  });

  it('retains every part of a verified combined broadcast in the copy ledger', async () => {
    await fixture(async (tx, service) => {
      const { user, source, target, ids } = await seed(tx, 'SHOW');
      const sourceShow = await tx.show.findUniqueOrThrow({ where: { mediaId: source.id } });
      const targetShow = await tx.show.findUniqueOrThrow({ where: { mediaId: target.id } });
      const s = await tx.season.create({
        data: { showId: sourceShow.id, number: 1, title: 'Source' },
      });
      const t = await tx.season.create({
        data: { showId: targetShow.id, number: 1, title: 'Target' },
      });
      const e = await tx.episode.create({
        data: {
          seasonId: s.id,
          number: 1,
          title: 'Combined',
          airDate: new Date('2020-01-01'),
          runtimeMinutes: 60,
        },
      });
      const parts: Array<{ id: string; value: string; number: number; title: string }> = [];
      for (const number of [1, 2]) {
        const part = await tx.episode.create({
          data: {
            seasonId: t.id,
            number,
            title: 'Part ' + number,
            airDate: new Date('2020-01-01'),
            runtimeMinutes: 30,
          },
        });
        const value = randomUUID();
        await tx.episodeExternalId.create({
          data: { episodeId: part.id, provider: 'TMDB', providerEntityKind: 'EPISODE', value },
        });
        parts.push({ ...part, value });
      }
      await tx.userEpisodeStatus.create({
        data: { userId: user.id, episodeId: e.id, watched: true, source: 'TVTIME' },
      });
      await tx.rating.create({
        data: { userId: user.id, episodeId: e.id, rating: 8, source: 'MANUAL' },
      });
      await tx.watchHistory.create({
        data: {
          userId: user.id,
          episodeId: e.id,
          mediaId: source.id,
          mediaType: 'SHOW',
          watchedAt: new Date('2020-01-01'),
          runtimeMinutes: 60,
        },
      });
      (service as any).remap.previewCrossMediaMapping = async () => ({
        pairs: [{ sourceId: e.id, targetIds: parts.map((p) => p.id), rule: 'verified-split' }],
        unmappedProtected: [],
      });
      const options = {
        mode: 'repair' as const,
        verifiedIds: ids,
        canonical: 'tmdb' as const,
        snapshot: [
          {
            number: 1,
            isSpecial: false,
            episodes: parts.map((p) => ({ tmdbId: p.value, number: p.number, title: p.title })),
          },
        ] as any,
      };
      const result = await service.identityFamily([source.id, target.id], target.id, options);
      expect(result.status).toBe('applied');
      expect(
        await tx.userEpisodeStatus.count({
          where: { userId: user.id, episodeId: { in: parts.map((p) => p.id) } },
        }),
      ).toBe(2);
      expect(
        await tx.rating.count({
          where: { userId: user.id, episodeId: { in: parts.map((p) => p.id) }, rating: 8 },
        }),
      ).toBe(2);
      expect(
        await tx.mediaCanonicalCopy.count({
          where: { sourceId: e.id, entityType: { startsWith: 'EPISODE' } },
        }),
      ).toBe(2);
      await expect(service.resolveEpisodeId(e.id)).rejects.toThrow('split');
    });
  });

  it('blocks a small ID-less graph with unexplained date drift', async () => {
    await fixture(async (tx, service) => {
      const { source, ids } = await seed(tx);
      const show = await tx.show.create({ data: { mediaId: source.id } });
      const season = await tx.season.create({
        data: { showId: show.id, number: 1, title: 'Season 1' },
      });
      await tx.episode.create({
        data: {
          seasonId: season.id,
          number: 1,
          title: 'An informative episode',
          airDate: new Date('2020-01-03'),
          runtimeMinutes: 22,
        },
      });
      const result = await service.splitIdentity(source.id, {
        mode: 'dry-run',
        type: 'SHOW',
        title: 'Stray',
        verifiedIds: [{ ...ids[1], providerEntityKind: 'SERIES' }],
        removeAliasIds: [],
        allowedCastIds: [],
        canonical: 'tmdb',
        snapshot: [
          {
            number: 1,
            isSpecial: false,
            episodes: [
              {
                tmdbId: 1,
                number: 1,
                title: 'An informative episode',
                airDate: '2020-01-01',
                runtimeMinutes: 22,
              },
            ],
          },
        ] as any,
      });
      expect(result.reason).toBe('stray-episode-membership-unproven');
      expect(await tx.show.findUnique({ where: { id: show.id } })).toMatchObject({
        mediaId: source.id,
      });
    });
  });

  it('splits into an existing show using the recovery ledger without a second visible target', async () => {
    await fixture(async (tx, service) => {
      const { user, source, ids } = await seed(tx);
      const destination = await tx.mediaItem.create({
        data: { type: 'SHOW', title: 'Canonical show', show: { create: {} } },
      });
      const show = await tx.show.create({ data: { mediaId: source.id } });
      const destShow = await tx.show.findUniqueOrThrow({ where: { mediaId: destination.id } });
      const fromSeason = await tx.season.create({
        data: { showId: show.id, number: 1, title: 'Season 1' },
      });
      const toSeason = await tx.season.create({
        data: { showId: destShow.id, number: 1, title: 'Season 1' },
      });
      const from = await tx.episode.create({
        data: {
          seasonId: fromSeason.id,
          number: 1,
          title: 'Pilot',
          airDate: new Date('2020-01-01'),
        },
      });
      const to = await tx.episode.create({
        data: { seasonId: toSeason.id, number: 1, title: 'Pilot', airDate: new Date('2020-01-01') },
      });
      const alias = randomUUID();
      await tx.episodeExternalId.create({
        data: {
          episodeId: from.id,
          provider: 'THE_TVDB',
          providerEntityKind: 'EPISODE',
          value: alias,
        },
      });
      await tx.userShowStatus.create({
        data: { userId: user.id, mediaId: source.id, dropped: true },
      });
      await tx.userEpisodeStatus.create({
        data: { userId: user.id, episodeId: from.id, watched: true },
      });
      (service as any).remap.previewCrossMediaMapping = async () => ({
        pairs: [{ sourceId: from.id, targetIds: [to.id] }],
        unmappedProtected: [],
      });
      const result = await service.splitIdentity(source.id, {
        mode: 'repair',
        type: 'SHOW',
        title: 'Canonical show',
        targetId: destination.id,
        verifiedIds: [{ ...ids[1], providerEntityKind: 'SERIES' }],
        removeAliasIds: [],
        allowedCastIds: [],
        canonical: 'tvdb',
        snapshot: [
          {
            number: 1,
            isSpecial: false,
            episodes: [{ tmdbId: alias, number: 1, title: 'Pilot', airDate: '2020-01-01' }],
          },
        ] as any,
      });
      expect(result.status).toBe('applied');
      expect(
        await tx.mediaItem.findUnique({ where: { id: source.id }, include: { show: true } }),
      ).toMatchObject({ type: 'MOVIE', show: null });
      expect(
        await tx.userEpisodeStatus.findFirst({ where: { userId: user.id, episodeId: to.id } }),
      ).toMatchObject({ watched: true });
      expect(
        await tx.userShowStatus.findFirst({ where: { userId: user.id, mediaId: destination.id } }),
      ).toMatchObject({ dropped: true });
      expect(
        await tx.mediaCanonicalLink.findFirst({ where: { targetMediaId: destination.id } }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(await service.resolveEpisodeId(from.id)).toBe(to.id);
    });
  });

  it('rejects an identity plan after an alias changes without activating a redirect', async () => {
    await fixture(async (tx, service) => {
      const { source, target, ids } = await seed(tx);
      const preview = await service.identityFamily([source.id, target.id], target.id, {
        mode: 'dry-run',
        verifiedIds: ids,
      });
      await tx.externalId.create({
        data: {
          provider: 'IMDB',
          providerEntityKind: 'MOVIE',
          value: 'tt' + Date.now(),
          mediaId: source.id,
        },
      });
      const result = await service.identityFamily([source.id, target.id], target.id, {
        mode: 'repair',
        verifiedIds: ids,
        fingerprint: preview.fingerprint,
      });
      expect(result.reason).toBe('stale-plan');
      expect(await tx.mediaCanonicalLink.count({ where: { sourceMediaId: source.id } })).toBe(0);
    });
  });

  it('splits a stray show without changing episode IDs or moving ambiguous movie ratings', async () => {
    await fixture(async (tx, service) => {
      const { user, source, ids } = await seed(tx);
      const show = await tx.show.create({
        data: { mediaId: source.id, structureProvider: 'TVDB' },
      });
      const season = await tx.season.create({
        data: { showId: show.id, number: 1, title: 'Season 1' },
      });
      const episode = await tx.episode.create({
        data: { seasonId: season.id, number: 1, title: 'Pilot', airDate: new Date('2020-01-01') },
      });
      const value = randomUUID();
      await tx.episodeExternalId.create({
        data: { episodeId: episode.id, provider: 'THE_TVDB', providerEntityKind: 'EPISODE', value },
      });
      await tx.userEpisodeStatus.create({
        data: { userId: user.id, episodeId: episode.id, watched: true },
      });
      await tx.userShowStatus.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          watchedCount: 1,
          totalCount: 1,
          dropped: true,
        },
      });
      await tx.watchHistory.create({
        data: {
          userId: user.id,
          mediaId: source.id,
          mediaType: 'SHOW',
          episodeId: episode.id,
          watchedAt: new Date('2020-01-01'),
        },
      });
      await tx.rating.create({
        data: { userId: user.id, mediaId: source.id, rating: 8, source: 'MANUAL' },
      });
      const options = {
        mode: 'dry-run' as const,
        type: 'SHOW' as const,
        title: 'Verified stray show',
        verifiedIds: [{ ...ids[1], providerEntityKind: 'SERIES' }],
        removeAliasIds: [],
        allowedCastIds: [],
        canonical: 'tvdb' as const,
        snapshot: [
          { number: 1, isSpecial: false, episodes: [{ tmdbId: value, number: 1, title: 'Pilot' }] },
        ] as any,
      };
      const preview = await service.splitIdentity(source.id, options);
      expect(preview.status).toBe('ready');
      const applied = await service.splitIdentity(source.id, {
        ...options,
        mode: 'repair',
        fingerprint: preview.fingerprint,
      });
      expect(applied.status).toBe('applied');
      expect(
        await tx.episode.findUnique({
          where: { id: episode.id },
          include: { season: { include: { show: true } } },
        }),
      ).toMatchObject({ season: { show: { mediaId: applied.targetMediaId } } });
      expect(
        await tx.userEpisodeStatus.count({ where: { episodeId: episode.id, userId: user.id } }),
      ).toBe(1);
      expect(
        await tx.userShowStatus.findFirst({ where: { mediaId: applied.targetMediaId } }),
      ).toMatchObject({ dropped: true });
      expect(await tx.rating.findFirst({ where: { mediaId: source.id } })).toMatchObject({
        rating: 8,
      });
      expect(await tx.watchHistory.findFirst({ where: { userId: user.id } })).toMatchObject({
        mediaId: applied.targetMediaId,
      });
      expect(await canonicalMediaId(tx, source.id, 'MOVIE')).toBe(source.id);
      expect(await canonicalMediaId(tx, source.id, 'SHOW')).toBe(applied.targetMediaId);
    });
  });
});
