import { MediaMetadataService } from './media-metadata.service';
import { currentLanguage } from '../common/language.context';

function fixture() {
  const entries = new Map<string, any>();
  const redis: any = {
    get: jest.fn(async (key) => entries.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      entries.set(key, value);
    }),
    del: jest.fn(async (key) => {
      entries.delete(key);
    }),
    client: {
      set: jest.fn(async (key, value) => {
        if (entries.has(key)) return null;
        entries.set(key, JSON.parse(value));
        return 'OK';
      }),
    },
  };
  const prisma: any = {
    episode: {
      findMany: jest.fn(async () => [{ id: 'episode', season: { show: { mediaId: 'show' } } }]),
    },
  };
  const tvdb: any = { enabled: true, getEpisode: jest.fn() };
  const tmdb: any = { enabled: true, localizedEpisodeBase: jest.fn() };
  const queue: any = { enqueueEpisodeMetadataRefresh: jest.fn(async () => ({})) };
  const legacy = { enabled: true, getEpisodeAirTimes: jest.fn() };
  const service = new MediaMetadataService(
    prisma,
    tmdb,
    tvdb,
    legacy as any,
    {} as any,
    queue,
    redis,
  );
  return { service, prisma, queue, entries, tvdb, tmdb, legacy, redis };
}

it('queues one background refresh across simultaneous readers without calling providers inline', async () => {
  const f = fixture();
  expect(
    await Promise.all([
      f.service.scheduleIncompleteEpisodeRefresh(['episode']),
      f.service.scheduleIncompleteEpisodeRefresh(['episode']),
    ]),
  ).toEqual([true, true]);
  expect(f.queue.enqueueEpisodeMetadataRefresh).toHaveBeenCalledTimes(1);
  expect(f.tvdb.getEpisode).not.toHaveBeenCalled();
  expect(f.tmdb.localizedEpisodeBase).not.toHaveBeenCalled();
  expect(f.queue.enqueueEpisodeMetadataRefresh).toHaveBeenCalledWith({
    episodeId: 'episode',
    mediaId: 'show',
    locale: 'en',
  });
});
it('refreshes the exact episode in the queued locale and ends polling on completion', async () => {
  const f = fixture();
  const refresh = jest
    .spyOn(f.service, 'refreshRecentIncompleteEpisodes')
    .mockImplementation(async () => {
      expect(currentLanguage()).toBe('fr');
      return { attempted: 1, refreshed: 1 };
    });
  await f.service.runEpisodeMetadataRefresh({
    episodeId: 'episode',
    mediaId: 'show',
    locale: 'fr',
  });
  expect(refresh).toHaveBeenCalledWith('show', ['episode']);
  expect(f.entries.get('episode-metadata:v3:episode:fr')).toEqual({ pending: false });
  expect(f.redis.set).toHaveBeenCalledWith(
    'episode-metadata:v3:episode:fr',
    { pending: false },
    300,
  );
});
it('does not repeatedly enqueue an upstream metadata miss', async () => {
  const f = fixture();
  jest
    .spyOn(f.service, 'refreshRecentIncompleteEpisodes')
    .mockResolvedValue({ attempted: 1, refreshed: 0 });
  await f.service.scheduleIncompleteEpisodeRefresh(['episode']);
  await f.service.runEpisodeMetadataRefresh({
    episodeId: 'episode',
    mediaId: 'show',
    locale: 'en',
  });
  expect(await f.service.scheduleIncompleteEpisodeRefresh(['episode'])).toBe(false);
  expect(f.queue.enqueueEpisodeMetadataRefresh).toHaveBeenCalledTimes(1);
  expect(f.redis.set).toHaveBeenCalledWith(
    'episode-metadata:v3:episode:en',
    { pending: false },
    300,
  );
});
it('releases a failed enqueue claim without making the list fail', async () => {
  const f = fixture();
  f.queue.enqueueEpisodeMetadataRefresh.mockRejectedValueOnce(new Error('queue unavailable'));
  expect(await f.service.scheduleIncompleteEpisodeRefresh(['episode'])).toBe(false);
  expect(await f.service.scheduleIncompleteEpisodeRefresh(['episode'])).toBe(true);
});
it('tracks full-show refresh completion without awaiting the provider on a read', async () => {
  const f = fixture();
  let finish!: () => void;
  const refresh = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(await f.service.startShowMetadataRefresh('show', refresh)).toBe(true);
  expect(await f.service.startShowMetadataRefresh('show', refresh)).toBe(true);
  expect(refresh).toHaveBeenCalledTimes(1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  expect(await f.service.startShowMetadataRefresh('show', refresh)).toBe(false);
});
it('keeps the legacy airtime entry point inert even if an injected provider claims to be enabled', async () => {
  const f = fixture();
  await f.service.ensureAirtimes('show');
  expect(f.legacy.getEpisodeAirTimes).not.toHaveBeenCalled();
  expect(f.prisma.episode.findMany).not.toHaveBeenCalled();
});

it('does not requeue complete streaming episodes once their timezone is correct', async () => {
  const f = fixture();
  f.prisma.episode.findMany.mockResolvedValue([
    {
      id: 'episode',
      title: 'Circle of Life',
      stillUrl: 'image',
      airDate: new Date('2026-09-16T04:00:00Z'),
      airTime: '00:00',
      season: { show: { mediaId: 'show', media: { externalIds: [{ value: '372264' }] } } },
    },
  ]);
  f.entries.set('tvdb:broadcast-schedule:v2:372264', {
    schedule: { airTime: '00:00', timeZone: 'America/New_York', legacyTimeZone: 'Europe/London' },
  });
  expect(await f.service.scheduleIncompleteEpisodeRefresh(['episode'])).toBe(false);
  expect(f.queue.enqueueEpisodeMetadataRefresh).not.toHaveBeenCalled();
});
