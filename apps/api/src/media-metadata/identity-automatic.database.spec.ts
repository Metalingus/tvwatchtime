import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ImportMatcher } from '../import/lib/matcher';
import { ImportProcessor } from '../import/import.processor';
import { ImportService } from '../import/import.service';
import { IDENTITY_PENDING_ERROR } from '../import/lib/structure-pending';
import { MediaReconciler } from './reconcile/media-reconciler.service';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { IdentityRepairService } from './identity-repair.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { HydrationProcessor } from './hydration/hydration.processor';

jest.setTimeout(30000);

const url = process.env.WATCHFORGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('automatic identity repair from an untouched corrupt catalog', () => {
  let db: PrismaClient;
  beforeAll(() => {
    if (!['localhost', '127.0.0.1'].includes(new URL(url!).hostname))
      throw new Error('Local fixture target required');
    db = new PrismaClient({ datasources: { db: { url } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  it.each([
    'aliases',
    'stray-show',
    'removed-input-alias',
    'integration-resume',
    'two-movie-identities',
  ])('ordinary matching repairs %s and rematches without a repair script', async (scenario) => {
    const rollback = new Error('ROLLBACK_FIXTURE');
    try {
      await db.$transaction(
        async (tx) => {
          const prisma: any = new Proxy(tx, {
            get: (obj, key) =>
              key === '$transaction' ? async (fn: any) => fn(tx) : (obj as any)[key],
          });
          const key = randomUUID(),
            number = 8_000_000_000 + Math.floor(Math.random() * 100_000_000);
          const good = 'tt' + number,
            bad = 'tt' + (number + 1);
          const user = await tx.user.create({
            data: { email: key + '@identity.invalid', username: key },
          });
          const media = await tx.mediaItem.create({
            data: {
              type: 'MOVIE',
              title: 'Fixture Movie',
              movie: { create: { releaseYear: 2000 } },
              externalIds: {
                create: [
                  { provider: 'TMDB', providerEntityKind: 'MOVIE', value: String(number) },
                  { provider: 'IMDB', providerEntityKind: 'MOVIE', value: good },
                  { provider: 'IMDB', providerEntityKind: 'MOVIE', value: bad },
                ],
              },
            },
          });
          if (scenario === 'two-movie-identities')
            await tx.externalId.create({
              data: {
                mediaId: media.id,
                provider: 'TMDB',
                providerEntityKind: 'MOVIE',
                value: String(number + 200),
              },
            });
          const other =
            scenario === 'removed-input-alias'
              ? await tx.mediaItem.create({
                  data: {
                    type: 'MOVIE',
                    title: 'Other Movie',
                    movie: { create: { releaseYear: 2001 } },
                    externalIds: {
                      create: {
                        provider: 'TMDB',
                        providerEntityKind: 'MOVIE',
                        value: String(number + 200),
                      },
                    },
                  },
                })
              : null;
          const importedIds = other ? { imdb: bad } : { tmdb: number };
          const importedTitle = other ? 'Other Movie' : 'Fixture Movie';
          let protectedEpisodeId: string | undefined;
          if (scenario === 'stray-show') {
            const show = await tx.show.create({
              data: { mediaId: media.id, yearStart: 2000, structureProvider: 'TMDB' },
            });
            const season = await tx.season.create({
              data: { showId: show.id, number: 1, title: 'Season 1' },
            });
            const episode = await tx.episode.create({
              data: {
                seasonId: season.id,
                number: 1,
                title: 'Verified episode',
                airDate: new Date('2000-01-01'),
                runtimeMinutes: 30,
                externalIds: {
                  create: {
                    provider: 'TMDB',
                    providerEntityKind: 'EPISODE',
                    value: String(number + 1000),
                  },
                },
              },
            });
            protectedEpisodeId = episode.id;
            await tx.userEpisodeStatus.create({
              data: { userId: user.id, episodeId: episode.id, watched: true },
            });
          }
          const imp = await tx.import.create({
            data: { userId: user.id, format: 'tvtime', status: 'MATCHING', totalRows: 1 },
          });
          const historical = await tx.import.create({
            data: { userId: user.id, format: 'tvtime', status: 'COMPLETED' },
          });
          const oldItem = await tx.importItem.create({
            data: {
              importId: historical.id,
              sourceEntityType: 'WATCHED_MOVIE',
              rawData: {},
              matchedMediaId: media.id,
              status: 'PENDING_MATCH',
              errorMessage: IDENTITY_PENDING_ERROR,
            },
          });
          const redis: any = {
            get: async () => null,
            set: async () => {},
            del: async () => {},
            delByPattern: async () => 0,
            client: { set: async () => 'OK', eval: async () => 1, incr: async () => 1 },
          };
          const queue = new HydrationQueue(redis);
          const jobs: any[] = [];
          (queue as any).queue = {
            getJob: async () => null,
            add: async (name: string, data: any) => {
              const job = { name, data };
              jobs.push(job);
              return job;
            },
          };
          const tmdb: any = {
            enabled: true,
            getMovieRoutingProfile: async () => ({
              tmdbId: number,
              title: 'Fixture Movie',
              releaseYear: 2000,
              imdbId: good,
            }),
            getShowRoutingProfile: async () => ({
              tmdbId: number + 100,
              title: 'Fixture Show',
              yearStart: 2000,
              imdbId: bad,
              tvdbId: null,
            }),
            getShow: async () => ({
              title: 'Fixture Show',
              cast: [],
              seasons: [
                {
                  number: 1,
                  isSpecial: false,
                  episodes: [
                    {
                      tmdbId: number + 1000,
                      number: 1,
                      title: 'Verified episode',
                      airDate: '2000-01-01',
                      runtimeMinutes: 30,
                    },
                  ],
                },
              ],
            }),
          };
          if (scenario === 'two-movie-identities') {
            const originalProfile = tmdb.getMovieRoutingProfile;
            tmdb.getMovieRoutingProfile = async (id: number) =>
              id === number + 200
                ? { tmdbId: number + 200, title: 'Other Movie', releaseYear: 2001, imdbId: bad }
                : originalProfile(id);
          }
          tmdb.findByExternalId = async (id: string) =>
            id === bad && other ? { movie: { tmdbId: number + 200 } } : {};
          const tvdb: any = { enabled: false };
          const wf: any = {
            lookup: async (query: any) => {
              const show = query.mediaType === 'tv';
              if (
                scenario === 'two-movie-identities' &&
                !show &&
                [String(number + 200), bad].includes(query.id)
              )
                return {
                  status: 'found',
                  identity: {
                    wfId: '789',
                    mediaType: 'movie',
                    title: 'Other Movie',
                    year: 2001,
                    ids: { tmdb: [String(number + 200)], tvdb: [], imdb: [bad], tvtime_uuid: [] },
                    primary: {
                      tmdb: String(number + 200),
                      tvdb: null,
                      imdb: bad,
                      tvtime_uuid: null,
                    },
                  },
                };
              if (
                show
                  ? scenario !== 'stray-show' || ![String(number + 100), bad].includes(query.id)
                  : ![String(number), good].includes(query.id)
              )
                return { status: 'unmapped' };
              return {
                status: 'found',
                identity: {
                  wfId: show ? '456' : '123',
                  mediaType: show ? 'tv' : 'movie',
                  title: show ? 'Fixture Show' : 'Fixture Movie',
                  year: 2000,
                  ids: {
                    tmdb: [String(show ? number + 100 : number)],
                    tvdb: [],
                    imdb: [show ? bad : good],
                    tvtime_uuid: [],
                  },
                  primary: {
                    tmdb: String(show ? number + 100 : number),
                    tvdb: null,
                    imdb: show ? bad : good,
                    tvtime_uuid: null,
                  },
                },
              };
            },
          };
          const reconciler = new MediaReconciler(prisma, {} as any, wf, tmdb, tvdb, queue);
          const canonical = new MediaCanonicalizationService(prisma, tmdb, redis, {
            emit: () => {},
          } as any);
          const matcher = new ImportMatcher(
            prisma,
            { lightUpsertMovie: async () => other!.id } as any,
            tmdb,
            tvdb,
            undefined,
            queue,
            canonical,
            reconciler,
          );
          const imports: any = Object.assign(Object.create(ImportService.prototype), {
            prisma,
            matcher,
            redis,
          });
          const events: any = {
            emit: () => {},
            emitAsync: async (name: string, payload: any) => {
              if (name === 'metadata.identity-repaired') await imports.onIdentityRepaired(payload);
            },
          };
          imports.events = events;
          const repair = new IdentityRepairService(
            prisma,
            redis,
            reconciler,
            canonical,
            queue,
            tmdb,
            tvdb,
          );
          const worker = new HydrationProcessor(
            redis,
            prisma,
            {} as any,
            {} as any,
            {} as any,
            tvdb,
            tmdb,
            queue,
            {} as any,
            {} as any,
            events,
            canonical,
            undefined,
            undefined,
            repair,
          );
          jest
            .spyOn(worker as any, 'identityRefresh')
            .mockImplementation(async ({ mediaId }: any) => ({ refreshed: true, mediaId }));
          const processor: any = Object.assign(Object.create(ImportProcessor.prototype), {
            prisma,
            matcher,
            hydrationQueue: queue,
            notifyImportReady: async () => {},
          });
          const match = await matcher.matchByExternalIds(
            importedIds,
            'MOVIE',
            importedTitle,
            importedTitle.toLowerCase(),
            other ? 2001 : 2000,
          );
          expect(match.identityPending).toBe(true);
          expect(jobs).toHaveLength(0); // No provider-heavy repair competes with import matching.
          const itemId = randomUUID();
          await processor.flushItems(imp.id, [
            {
              id: itemId,
              importId: imp.id,
              sourceEntityType: 'WATCHED_MOVIE',
              rawData: { ids: importedIds },
              normalizedData: { title: importedTitle, year: other ? 2001 : 2000 },
              matchedMediaId: match.mediaId,
              confidenceScore: match.confidence,
              status: 'MATCHED',
            },
          ]);
          await processor.finishProcessing(imp.id, { totalRows: 1, matchedCount: 1 });
          expect(jobs).toHaveLength(1);
          expect(jobs[0]).toMatchObject({ name: 'identity-repair', data: { mediaId: media.id } });
          expect(await tx.importItem.findUnique({ where: { id: itemId } })).toMatchObject({
            status: 'PENDING_MATCH',
          });
          if (scenario === 'integration-resume') {
            await tx.import.update({
              where: { id: imp.id },
              data: { format: 'trakt', status: 'COMPLETED' },
            });
            imports.applyBatch = jest
              .fn()
              .mockRejectedValueOnce(new Error('Interrupted after rematching'))
              .mockImplementation(async (_userId: string, _importId: string, items: any[]) => {
                await tx.importItem.updateMany({
                  where: { id: { in: items.map((item) => item.id) } },
                  data: { status: 'APPLIED' },
                });
              });
            imports.rebuildShowStatuses = jest.fn().mockResolvedValue(undefined);
            await expect((worker as any).dispatch(jobs[0].name, jobs[0].data)).rejects.toThrow(
              'Interrupted after rematching',
            );
            expect(await tx.importItem.findUnique({ where: { id: itemId } })).toMatchObject({
              status: 'MATCHED',
              errorMessage: IDENTITY_PENDING_ERROR,
            });
          }
          await (worker as any).dispatch(jobs[0].name, jobs[0].data);
          if (scenario === 'integration-resume')
            expect(imports.applyBatch).toHaveBeenCalledTimes(2);
          expect(
            await tx.externalId.count({ where: { mediaId: media.id, provider: 'IMDB' } }),
          ).toBe(1);
          expect(await tx.importItem.findUnique({ where: { id: itemId } })).toMatchObject({
            status: scenario === 'integration-resume' ? 'APPLIED' : 'MATCHED',
            matchedMediaId: other?.id ?? media.id,
            errorMessage: null,
          });
          expect(await tx.import.findUnique({ where: { id: imp.id } })).toMatchObject({
            status: scenario === 'integration-resume' ? 'COMPLETED' : 'READY_FOR_REVIEW',
            unmatchedCount: 0,
            needsReviewCount: 0,
          });
          expect(await tx.importItem.findUnique({ where: { id: oldItem.id } })).toMatchObject({
            status: 'PENDING_MATCH',
            errorMessage: IDENTITY_PENDING_ERROR,
          });
          const providerLookup = jest.spyOn(wf, 'lookup');
          const healthy = await matcher.matchByExternalIds(
            { tmdb: number },
            'MOVIE',
            'Fixture Movie',
            'fixture movie',
            2000,
          );
          expect(healthy.mediaId).toBe(media.id);
          expect(healthy.identityPending).toBeUndefined();
          expect(providerLookup).not.toHaveBeenCalled();
          expect(jobs).toHaveLength(1);
          expect(await tx.watchHistory.count({ where: { userId: user.id } })).toBe(0);
          if (protectedEpisodeId) {
            expect(
              await tx.mediaItem.findUnique({ where: { id: media.id }, select: { show: true } }),
            ).toEqual({ show: null });
            const episode = await tx.episode.findUniqueOrThrow({
              where: { id: protectedEpisodeId },
              include: { season: { include: { show: true } } },
            });
            expect(episode.season.show.mediaId).not.toBe(media.id);
            expect(
              await tx.userEpisodeStatus.findFirst({
                where: { episodeId: protectedEpisodeId, userId: user.id },
              }),
            ).toMatchObject({ watched: true });
          }
          throw rollback;
        },
        { timeout: 60000 },
      );
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
