import { Logger } from '@nestjs/common';
import { MovieIdentityService } from './movie-identity.service';

const alias = (provider: string, value: string, kind = 'MOVIE') => ({
  provider,
  providerEntityKind: kind,
  value,
  mediaId: 'movie',
});

function setup() {
  const media: any = {
    type: 'MOVIE',
    canonicalSource: null,
    externalIds: [alias('TMDB', '1368337'), alias('IMDB', 'tt33764258')],
  };
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'movie' }]),
    mediaItem: { findUnique: jest.fn(async () => media) },
    externalId: {
      findUnique: jest.fn().mockResolvedValue(null),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    mediaItem: { findUnique: jest.fn(async () => media) },
    $transaction: jest.fn(async (fn: any, _options?: any) => fn(tx)),
  };
  const tmdb = {
    enabled: true,
    getImdbIdForMovieStrict: jest.fn().mockResolvedValue('tt33764258'),
  };
  const tvdb = {
    enabled: true,
    getMovieIdentity: jest
      .fn()
      .mockResolvedValue({ tvdbId: 362547, tmdbId: 1368337, imdbId: 'tt33764258' }),
    findMovieByImdb: jest
      .fn()
      .mockResolvedValue({ tvdbId: 362547, tmdbId: 1368337, imdbId: 'tt33764258' }),
  };
  const cached = new Map<string, unknown>();
  const redis = {
    get: jest.fn(async (key: string) => cached.get(key) ?? null),
    set: jest.fn(async (key: string, value: unknown, _ttl: number) => {
      cached.set(key, value);
    }),
  };
  const watchforge = { lookup: jest.fn().mockResolvedValue({ status: 'unmapped' }) };
  return {
    service: new MovieIdentityService(
      prisma as any,
      tmdb as any,
      tvdb as any,
      redis as any,
      watchforge as any,
    ),
    watchforge,
    media,
    prisma,
    tx,
    tmdb,
    tvdb,
    redis,
    cached,
  };
}

describe('MovieIdentityService', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation());
  afterEach(() => jest.restoreAllMocks());

  it('can resolve TVDB through a verified TMDB link when IMDb is absent', async () => {
    const f = setup();
    f.media.externalIds = [alias('TMDB', '1368337')];
    f.tmdb.getImdbIdForMovieStrict.mockResolvedValue(null);
    (f.service as any).identities = {
      resolveProviderIdentity: jest.fn().mockResolvedValue({
        status: 'verified',
        anchorVerified: true,
        externals: [alias('TMDB', '1368337'), alias('THE_TVDB', '362547')],
      }),
    };
    expect(await f.service.resolveTvdbId('movie')).toBe(362547);
    expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('uses WatchForge only as a candidate and verifies its live TVDB movie identity', async () => {
    const f = setup();
    f.tvdb.findMovieByImdb.mockResolvedValue(null);
    f.watchforge.lookup.mockResolvedValue({
      status: 'found',
      identity: {
        ids: { tmdb: ['1368337'], tvdb: ['362547'], imdb: ['tt33764258'], tvtime_uuid: [] },
      },
    });
    expect(await f.service.ensureTvdbId('movie')).toBe(362547);
    expect(f.watchforge.lookup).toHaveBeenCalledWith(
      { provider: 'tmdb', mediaType: 'movie', id: '1368337' },
      { lane: 'repair' },
    );
    expect(f.tvdb.getMovieIdentity).toHaveBeenCalledWith(362547);
    expect(f.tx.externalId.createMany).toHaveBeenCalledWith({
      data: [alias('THE_TVDB', '362547')],
    });
  });

  it('rejects a WatchForge candidate whose live provider belongs to a different movie', async () => {
    const f = setup();
    f.tvdb.findMovieByImdb.mockResolvedValue(null);
    f.watchforge.lookup.mockResolvedValue({
      status: 'found',
      identity: {
        ids: { tmdb: ['1368337'], tvdb: ['362547'], imdb: ['tt33764258'], tvtime_uuid: [] },
      },
    });
    f.tvdb.getMovieIdentity.mockResolvedValue({ tvdbId: 362547, tmdbId: 999, imdbId: 'tt999' });
    expect(await f.service.ensureTvdbId('movie')).toBeNull();
    expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('does not choose among several WatchForge TVDB aliases', async () => {
    const f = setup();
    f.tvdb.findMovieByImdb.mockResolvedValue(null);
    f.watchforge.lookup.mockResolvedValue({
      status: 'found',
      identity: {
        ids: { tmdb: ['1368337'], tvdb: ['362547', '999'], imdb: ['tt33764258'], tvtime_uuid: [] },
      },
    });
    expect(await f.service.ensureTvdbId('movie')).toBeNull();
    expect(f.tvdb.getMovieIdentity).not.toHaveBeenCalled();
    expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('treats disabled verified-identity lookups as a miss, not an outage', async () => {
    const f = setup();
    f.media.externalIds = [alias('TMDB', '1368337')];
    f.tmdb.getImdbIdForMovieStrict.mockResolvedValue(null);
    (f.service as any).identities = {
      resolveProviderIdentity: jest
        .fn()
        .mockResolvedValue({ status: 'deferred', reason: 'disabled' }),
    };
    expect(await f.service.ensureTvdbId('movie')).toBeNull();
    expect(f.redis.set).not.toHaveBeenCalledWith(expect.any(String), 'retry', 60);
    expect(f.redis.set).toHaveBeenCalledWith(expect.any(String), 'no-match', 3600);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('defers a WatchForge outage without stamping a definitive no-match', async () => {
    const f = setup();
    f.tvdb.findMovieByImdb.mockResolvedValue(null);
    f.watchforge.lookup.mockResolvedValue({ status: 'deferred', reason: 'quota' });
    expect(await f.service.ensureTvdbId('movie')).toBeNull();
    expect(f.redis.set).toHaveBeenCalledWith(expect.any(String), 'retry', 60);
    expect(f.redis.set).not.toHaveBeenCalledWith(
      expect.any(String),
      'no-match',
      expect.any(Number),
    );
    expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('adds only the verified TVDB movie alias to the existing movie', async () => {
    const { service, tx, prisma, tvdb } = setup();
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
    expect(tvdb.findMovieByImdb).toHaveBeenCalledWith('tt33764258', 1368337);
    expect(tx.externalId.createMany).toHaveBeenCalledWith({ data: [alias('THE_TVDB', '362547')] });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('obtains a missing IMDb ID from TMDB and saves both verified aliases together', async () => {
    const { service, tx, media } = setup();
    media.externalIds = [alias('TMDB', '1368337')];
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
    expect(tx.externalId.createMany).toHaveBeenCalledWith({
      data: [alias('THE_TVDB', '362547'), alias('IMDB', 'tt33764258')],
    });
  });

  it('can enrich an IMDb-only movie when TMDB is disabled', async () => {
    const { service, media, tmdb } = setup();
    tmdb.enabled = false;
    media.externalIds = [alias('IMDB', 'tt33764258')];
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
    expect(tmdb.getImdbIdForMovieStrict).not.toHaveBeenCalled();
  });

  it('accepts an IMDb bridge without a TVDB remote TMDB link only after TMDB corroborates it', async () => {
    const { service, tvdb } = setup();
    tvdb.findMovieByImdb.mockResolvedValue({ tvdbId: 362547, tmdbId: null, imdbId: 'tt33764258' });
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
  });

  it('refuses an uncorroborated IMDb bridge when there is a local TMDB anchor', async () => {
    const { service, tvdb, tmdb, tx } = setup();
    tvdb.findMovieByImdb.mockResolvedValue({ tvdbId: 362547, tmdbId: null, imdbId: 'tt33764258' });
    tmdb.getImdbIdForMovieStrict.mockResolvedValue(null);
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
    expect(tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('does not look up an existing TVDB alias or overwrite it', async () => {
    const { service, media, tvdb, tx } = setup();
    media.externalIds.push(alias('THE_TVDB', '42'));
    await expect(service.ensureTvdbId('movie')).resolves.toBe(42);
    expect(tvdb.findMovieByImdb).not.toHaveBeenCalled();
    expect(tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it.each([
    [
      'wrong type',
      (m: any) => {
        m.type = 'SHOW';
      },
    ],
    [
      'canonical source',
      (m: any) => {
        m.canonicalSource = { status: 'ACTIVE' };
      },
    ],
    [
      'multiple TMDB aliases',
      (m: any) => {
        m.externalIds.push(alias('TMDB', '25'));
      },
    ],
    [
      'multiple IMDb aliases',
      (m: any) => {
        m.externalIds.push(alias('IMDB', 'tt25'));
      },
    ],
    [
      'invalid TVDB alias',
      (m: any) => {
        m.externalIds.push(alias('THE_TVDB', '0'));
      },
    ],
    [
      'invalid IMDb alias',
      (m: any) => {
        m.externalIds = [alias('IMDB', '1368337')];
      },
    ],
    [
      'no movie anchors',
      (m: any) => {
        m.externalIds = [alias('TMDB', '1368337', 'SERIES')];
      },
    ],
  ])('leaves %s unchanged', async (_name, mutate) => {
    const { service, media, tvdb, tx } = setup();
    mutate(media);
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
    expect(tvdb.findMovieByImdb).not.toHaveBeenCalled();
    expect(tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('does not treat a SERIES alias with the same number as a MOVIE alias', async () => {
    const { service, media, tx } = setup();
    media.externalIds.push(alias('THE_TVDB', '362547', 'SERIES'));
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
    expect(tx.externalId.createMany).toHaveBeenCalledWith({ data: [alias('THE_TVDB', '362547')] });
  });

  it('refuses a stored IMDb/TMDB contradiction before querying TVDB', async () => {
    const { service, tmdb, tvdb, tx } = setup();
    tmdb.getImdbIdForMovieStrict.mockResolvedValue('tt999');
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
    expect(tvdb.findMovieByImdb).not.toHaveBeenCalled();
    expect(tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it.each(['THE_TVDB', 'IMDB'])(
    'does not steal a %s alias owned by another row',
    async (provider) => {
      const { service, media, tx } = setup();
      media.externalIds = [alias('TMDB', '1368337')];
      tx.externalId.findUnique.mockImplementation(async (args: any) =>
        args.where.provider_providerEntityKind_value.provider === provider
          ? { mediaId: 'other' }
          : null,
      );
      await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
      expect(tx.externalId.createMany).not.toHaveBeenCalled();
    },
  );

  it.each(['anchor', 'canonical', 'tvdb'])(
    'rechecks a changed %s after provider lookup',
    async (change) => {
      const { service, media, tx } = setup();
      const current = { ...media, externalIds: [...media.externalIds] };
      if (change === 'anchor') current.externalIds = [alias('TMDB', '99')];
      if (change === 'canonical') current.canonicalSource = { status: 'ACTIVE' };
      if (change === 'tvdb') current.externalIds.push(alias('THE_TVDB', '99'));
      tx.mediaItem.findUnique.mockResolvedValue(current);
      await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
      expect(tx.externalId.createMany).not.toHaveBeenCalled();
    },
  );

  it('tolerates a concurrent unique claim without updating that alias', async () => {
    const { service, tx } = setup();
    tx.externalId.createMany.mockRejectedValue({ code: 'P2002' });
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
  });

  it('retries serialization conflicts with a fresh transaction', async () => {
    const { service, prisma } = setup();
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2034' });
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  it('coalesces simultaneous requests for one movie', async () => {
    const { service, tvdb } = setup();
    await expect(
      Promise.all([service.ensureTvdbId('movie'), service.ensureTvdbId('movie')]),
    ).resolves.toEqual([362547, 362547]);
    expect(tvdb.findMovieByImdb).toHaveBeenCalledTimes(1);
  });

  it('backs off a genuine miss and retries when the identity changes', async () => {
    const { service, tvdb, redis, media } = setup();
    tvdb.findMovieByImdb.mockResolvedValue(null);
    await service.ensureTvdbId('movie');
    await service.ensureTvdbId('movie');
    expect(tvdb.findMovieByImdb).toHaveBeenCalledTimes(1);
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), 'no-match', 3600);
    media.externalIds = [alias('IMDB', 'tt999')];
    await service.ensureTvdbId('movie');
    expect(tvdb.findMovieByImdb).toHaveBeenCalledTimes(2);
  });

  it('uses a short retry delay for outages and never stores them as a normal miss', async () => {
    const { service, tvdb, redis, cached, tx } = setup();
    tvdb.findMovieByImdb.mockRejectedValueOnce(new Error('timeout'));
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
    expect(redis.set).toHaveBeenCalledWith(expect.any(String), 'retry', 60);
    expect(tx.externalId.createMany).not.toHaveBeenCalled();
    cached.clear();
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
  });

  it('continues safely if the retry cache is unavailable', async () => {
    const { service, redis } = setup();
    redis.get.mockRejectedValue(new Error('redis'));
    await expect(service.ensureTvdbId('movie')).resolves.toBe(362547);
  });

  it('does not contact disabled TVDB', async () => {
    const { service, tvdb, prisma } = setup();
    tvdb.enabled = false;
    await expect(service.ensureTvdbId('movie')).resolves.toBeNull();
    expect(prisma.mediaItem.findUnique).not.toHaveBeenCalled();
  });
});

describe('MovieIdentityService read-only provider resolution', () => {
  it.each([
    [1368337, 'tt33764258', 362547],
    [550, 'tt0137523', 12345],
    [999, 'tt1234567', 54321],
  ])(
    'resolves any verified movie %s even when its TVDB alias belongs to another row',
    async (tmdbId, imdbId, tvdbId) => {
      const f = setup();
      f.media.externalIds = [alias('TMDB', String(tmdbId)), alias('IMDB', imdbId)];
      f.tmdb.getImdbIdForMovieStrict.mockResolvedValue(imdbId);
      f.tvdb.findMovieByImdb.mockResolvedValue({ tvdbId, tmdbId, imdbId });
      f.tx.externalId.findUnique.mockResolvedValue({ mediaId: 'duplicate-row' });
      await expect(f.service.ensureTvdbId('movie')).resolves.toBeNull();
      await expect(f.service.resolveTvdbId('movie')).resolves.toBe(tvdbId);
      expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
      expect(f.prisma.$transaction).toHaveBeenCalledTimes(1); // Only the attach attempt.
    },
  );

  it('does not write to the catalog during identity resolution', async () => {
    const f = setup();
    await expect(f.service.resolveTvdbId('movie')).resolves.toBe(362547);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
    expect(f.tx.externalId.findUnique).not.toHaveBeenCalled();
    expect(f.tx.externalId.createMany).not.toHaveBeenCalled();
  });

  it('refuses an anchor change while a read lookup is in flight', async () => {
    const f = setup();
    f.prisma.mediaItem.findUnique
      .mockResolvedValueOnce(structuredClone(f.media))
      .mockResolvedValueOnce({ ...f.media, externalIds: [alias('TMDB', '999')] });
    await expect(f.service.resolveTvdbId('movie')).resolves.toBeNull();
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does not let a failed catalog write suppress a valid read lookup', async () => {
    const f = setup();
    f.tx.externalId.createMany.mockRejectedValue(new Error('database unavailable'));
    await expect(f.service.ensureTvdbId('movie')).resolves.toBeNull();
    await expect(f.service.resolveTvdbId('movie')).resolves.toBe(362547);
  });

  it('coalesces simultaneous read lookups', async () => {
    const f = setup();
    await expect(
      Promise.all([f.service.resolveTvdbId('movie'), f.service.resolveTvdbId('movie')]),
    ).resolves.toEqual([362547, 362547]);
    expect(f.tvdb.findMovieByImdb).toHaveBeenCalledTimes(1);
    expect(f.prisma.$transaction).not.toHaveBeenCalled();
  });
});
