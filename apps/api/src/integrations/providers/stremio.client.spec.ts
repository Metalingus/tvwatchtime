import { deflateSync } from 'zlib';
import { providerJson } from './provider-http';
import { StremioClient } from './stremio.client';

jest.mock('./provider-http', () => ({ providerJson: jest.fn() }));

const imdb = 'tt1234567';
const videos = Array.from({ length: 6 }, (_, index) => `${imdb}:1:${index + 1}`);
const watchedFirstFour = `${videos[3]}:4:${deflateSync(Buffer.from([0b00001111])).toString('base64')}`;

function mockLibrary(state: Record<string, unknown>) {
  (providerJson as jest.Mock).mockResolvedValueOnce({
    result: [{ _id: imdb, name: 'Example Show', type: 'series', state }],
  });
}

function mockVideos() {
  (providerJson as jest.Mock).mockResolvedValueOnce({
    meta: { videos: videos.map((id) => ({ id })) },
  });
}

beforeEach(() => {
  (providerJson as jest.Mock).mockReset();
});

describe('Stremio episode watched state', () => {
  it.each([
    ['queued next episode', { video_id: videos[4], timeOffset: 1 }],
    ['partially played next episode', { video_id: videos[4], timeOffset: 60_000 }],
    ['camelCase playback pointer', { videoId: videos[4], timeOffset: 1 }],
  ])('imports only the four watched bits with a %s', async (_, playbackState) => {
    mockLibrary({
      timesWatched: 4,
      watched: watchedFirstFour,
      lastWatched: '2026-09-06T12:00:00Z',
      flaggedWatched: 0,
      duration: 1_800_000,
      ...playbackState,
    });
    mockVideos();

    const result = await new StremioClient().sync('auth-key');
    const episodes = result.items.filter((item) => item.entityType === 'WATCHED_EPISODE');

    expect(episodes.map((item) => item.episode)).toEqual([1, 2, 3, 4]);
    expect(episodes.every((item) => item.watchCount === 1)).toBe(true);
    expect(episodes[3].watchedAt).toBe('2026-09-06T12:00:00.000Z');
    expect(result.items).toContainEqual(expect.objectContaining({ entityType: 'WATCHLIST_SHOW' }));
  });

  it('imports explicitly watched episodes even when the series watch count is zero', async () => {
    mockLibrary({ timesWatched: 0, video_id: videos[4], watched: watchedFirstFour });
    mockVideos();

    const result = await new StremioClient().sync('auth-key');

    expect(
      result.items
        .filter((item) => item.entityType === 'WATCHED_EPISODE')
        .map((item) => item.episode),
    ).toEqual([1, 2, 3, 4]);
  });

  it.each([undefined, null, 'invalid-bitfield'])(
    'does not infer a watched episode from the playback pointer when watched is %s',
    async (watched) => {
      mockLibrary({ timesWatched: 4, video_id: videos[4], watched });
      if (typeof watched === 'string') mockVideos();

      const result = await new StremioClient().sync('auth-key');

      expect(result.items.map((item) => item.entityType)).toEqual(['WATCHLIST_SHOW']);
    },
  );

  it('does not infer a watched episode when Cinemeta is unavailable', async () => {
    mockLibrary({ timesWatched: 4, video_id: videos[4], watched: watchedFirstFour });
    (providerJson as jest.Mock).mockRejectedValueOnce(new Error('Cinemeta unavailable'));

    const result = await new StremioClient().sync('auth-key');

    expect(result.items.map((item) => item.entityType)).toEqual(['WATCHLIST_SHOW']);
    expect(result.snapshotEntityTypes).toBeUndefined();
    expect(result.snapshotScopes).toBeUndefined();
  });
});
