import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ShowsService } from './shows.service';

type FnMap = Record<string, jest.Mock>;

function model(fns: string[]): FnMap {
  const m: FnMap = {};
  for (const f of fns) m[f] = jest.fn().mockResolvedValue(undefined);
  return m;
}

function mockPrisma() {
  return {
    userEpisodeStatus: model(['findUnique', 'update', 'groupBy']),
    rating: model(['findUnique', 'upsert', 'groupBy']),
    reaction: model(['findUnique', 'findMany', 'create', 'delete', 'groupBy']),
    characterVote: model(['findUnique', 'upsert', 'deleteMany', 'groupBy']),
    mediaCast: model(['findFirst']),
    episode: model(['findUnique']),
  } as any;
}

describe('ShowsService voting', () => {
  let prisma: ReturnType<typeof mockPrisma>;
  let service: ShowsService;

  beforeEach(() => {
    prisma = mockPrisma();
    service = new ShowsService(prisma, undefined as any, undefined as any, undefined as any);
  });

  describe('voteDevice', () => {
    it('throws when the episode is not watched/tracked', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue(null);
      await expect(service.voteDevice('u', 'e', 'TV')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects an invalid device value', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteDevice('u', 'e', 'WATCH')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.userEpisodeStatus.update).not.toHaveBeenCalled();
    });

    it('upserts the device and returns the recomputed section', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1', device: 'TV' });
      prisma.userEpisodeStatus.groupBy.mockResolvedValue([
        { device: 'TV', _count: { _all: 3 } },
        { device: 'PHONE', _count: { _all: 1 } },
      ]);
      const section = await service.voteDevice('u', 'e', 'TV');
      expect(prisma.userEpisodeStatus.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { device: 'TV' } }),
      );
      expect(section.userVote).toBe('TV');
      expect(section.total).toBe(4);
      const byValue = new Map(section.options.map((o: any) => [o.value, o.count]));
      expect(byValue.get('TV')).toBe(3);
      expect(byValue.get('PHONE')).toBe(1);
      expect(byValue.get('TABLET')).toBe(0);
    });
  });

  describe('voteRating', () => {
    it('rejects out-of-range ratings', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteRating('u', 'e', 0)).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.voteRating('u', 'e', 6)).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.rating.upsert).not.toHaveBeenCalled();
    });

    it('upserts the rating and returns the section with exact buckets', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.rating.findUnique.mockResolvedValue({ rating: 4 });
      prisma.rating.groupBy.mockResolvedValue([
        { rating: 4, _count: { _all: 5 } },
        { rating: 5, _count: { _all: 2 } },
      ]);
      const section = await service.voteRating('u', 'e', 4);
      expect(prisma.rating.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ rating: 4 }) }),
      );
      expect(section.userVote).toBe('4');
      expect(section.total).toBe(7);
      const byValue = new Map(section.options.map((o: any) => [o.value, o.count]));
      expect(byValue.get('4')).toBe(5);
      expect(byValue.get('5')).toBe(2);
      expect(byValue.get('1')).toBe(0);
    });
  });

  describe('voteReaction', () => {
    it('rejects an invalid reaction', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      await expect(service.voteReaction('u', 'e', 'HAPPY')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.reaction.create).not.toHaveBeenCalled();
      expect(prisma.reaction.delete).not.toHaveBeenCalled();
    });

    it('toggles a reaction on (creates when absent)', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.reaction.findUnique.mockResolvedValue(null); // not yet present
      prisma.reaction.findMany.mockResolvedValue([{ reaction: 'SAD' }]);
      prisma.reaction.groupBy
        .mockResolvedValueOnce([{ userId: 'u' }]) // distinct users
        .mockResolvedValueOnce([{ reaction: 'SAD', _count: { _all: 1 } }]); // per-reaction counts
      const section: any = await service.voteReaction('u', 'e', 'SAD');
      expect(prisma.reaction.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ reaction: 'SAD' }) }),
      );
      expect(prisma.reaction.delete).not.toHaveBeenCalled();
      expect(section.userVotes).toEqual(['SAD']);
      expect(section.total).toBe(1);
      expect(new Map(section.options.map((o: any) => [o.value, o.count])).get('SAD')).toBe(1);
    });

    it('toggles a reaction off (deletes when present)', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.reaction.findUnique.mockResolvedValue({ id: 'r1' }); // already present
      prisma.reaction.findMany.mockResolvedValue([]);
      prisma.reaction.groupBy.mockResolvedValue([]); // no reactions left
      await service.voteReaction('u', 'e', 'SAD');
      expect(prisma.reaction.delete).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' } }));
      expect(prisma.reaction.create).not.toHaveBeenCalled();
    });
  });

  describe('voteFavoriteCharacter', () => {
    it('rejects a cast id that is not part of the show', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.mediaCast.findFirst.mockResolvedValue(null);
      await expect(service.voteFavoriteCharacter('u', 'e', 'foreign')).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.characterVote.upsert).not.toHaveBeenCalled();
    });

    it('upserts the favorite by stable cast id', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.mediaCast.findFirst.mockResolvedValue({ id: 'c1' });
      prisma.characterVote.findUnique.mockResolvedValue({ castId: 'c1' });
      prisma.characterVote.groupBy.mockResolvedValue([{ castId: 'c1', _count: { _all: 1 } }]);
      const section = await service.voteFavoriteCharacter('u', 'e', 'c1');
      expect(prisma.characterVote.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ castId: 'c1' }) }),
      );
      expect(section.userVote).toBe('c1');
      expect(section.total).toBe(1);
    });

    it('deletes the vote when value is null', async () => {
      prisma.userEpisodeStatus.findUnique.mockResolvedValue({ id: 's1' });
      prisma.episode.findUnique.mockResolvedValue({ season: { show: { mediaId: 'm1' } } });
      prisma.characterVote.groupBy.mockResolvedValue([]);
      await service.voteFavoriteCharacter('u', 'e', null);
      expect(prisma.characterVote.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'u', episodeId: 'e' } }));
    });
  });
});
