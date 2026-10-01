import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  EXPLORE_SECTION_IDS,
  STREAMING_TOP_SECTION_IDS,
  normalizeExploreSections,
} from '@tvwatch/shared';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/user.dto';

function fixture() {
  const profiles = new Map<string, any>();
  const prisma: any = {
    user: {
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        username: where.id,
        email: 'fixture@example.test',
        createdAt: new Date('2026-01-01'),
        profile: profiles.get(where.id),
        authProviders: [],
      })),
    },
    userProfile: {
      findUnique: jest.fn(async ({ where }: any) => profiles.get(where.userId) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const previous = profiles.get(where.userId);
        const patch = Object.fromEntries(
          Object.entries(previous ? update : create)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, value === Prisma.DbNull ? null : value]),
        );
        profiles.set(where.userId, { ...previous, ...patch });
      }),
    },
    follow: { count: jest.fn(async () => 0) },
    comment: { count: jest.fn(async () => 0) },
  };
  return { service: new UsersService(prisma, {} as any, {} as any, {} as any), prisma };
}

it('persists section preferences per account and returns them in /me', async () => {
  const { service } = fixture();
  const layout = normalizeExploreSections({
    order: ['upcomingMovies'],
    hidden: ['trendingMovies'],
  });
  const saved = await service.updateMe('alice', { exploreSections: layout });
  expect(saved.exploreSections).toEqual(layout);
  expect((await service.getMe('alice')).exploreSections).toEqual(layout);
  expect((await service.getMe('bob')).exploreSections).toBeNull();
});

it('preserves layout on unrelated profile updates and supports clearing it', async () => {
  const { service } = fixture();
  const layout = normalizeExploreSections({ hidden: [...EXPLORE_SECTION_IDS] });
  await service.updateMe('alice', { exploreSections: layout });
  await service.updateMe('alice', { displayName: 'Alice' });
  expect((await service.getMe('alice')).exploreSections).toEqual(layout);
  expect((await service.updateMe('alice', { exploreSections: null })).exploreSections).toBeNull();
});

it('keeps sections an older app build does not know when that build saves its layout', async () => {
  const { service } = fixture();
  // A new build hid one chart and moved another to the top.
  const modern = normalizeExploreSections({
    order: ['netflixTopShows', 'trendingShows'],
    hidden: ['hboTopMovies', 'topRatedMovies'],
  });
  await service.updateMe('alice', { exploreSections: modern });
  // An old build only knows the original 8 ids: it reorders and un-hides topRatedMovies.
  const legacyIds = EXPLORE_SECTION_IDS.filter(
    (id) => !(STREAMING_TOP_SECTION_IDS as readonly string[]).includes(id),
  );
  const legacyOrder = [...legacyIds].reverse();
  const saved = await service.updateMe('alice', {
    exploreSections: { order: legacyOrder, hidden: [] } as any,
  });
  expect(saved.exploreSections!.hidden).toEqual(['hboTopMovies']);
  expect(saved.exploreSections!.order[0]).toBe('netflixTopShows');
  expect(saved.exploreSections!.order.filter((id) => legacyIds.includes(id as any))).toEqual(
    legacyOrder,
  );
  expect(saved.exploreSections!.order).toHaveLength(EXPLORE_SECTION_IDS.length);
});

it('lets a client that knows every section replace the stored layout', async () => {
  const { service } = fixture();
  await service.updateMe('alice', {
    exploreSections: normalizeExploreSections({ hidden: ['netflixTopShows'] }),
  });
  const next = normalizeExploreSections({ order: ['hboTopShows'], hidden: [] });
  expect((await service.updateMe('alice', { exploreSections: next })).exploreSections).toEqual(
    next,
  );
});

it('validates section IDs, unique order, and bounded array sizes before persistence', async () => {
  const invalid = [
    { order: ['unknown'], hidden: [] },
    { order: ['upcomingMovies', 'upcomingMovies'], hidden: [] },
    { order: [], hidden: ['unknown'] },
    { order: 'upcomingMovies', hidden: [] },
  ];
  for (const exploreSections of invalid) {
    const errors = await validate(plainToInstance(UpdateProfileDto, { exploreSections }));
    expect(errors.some((error) => error.property === 'exploreSections')).toBe(true);
  }
  expect(
    await validate(
      plainToInstance(UpdateProfileDto, {
        exploreSections: normalizeExploreSections(null),
      }),
    ),
  ).toEqual([]);
  expect(await validate(plainToInstance(UpdateProfileDto, { exploreSections: null }))).toEqual([]);
});
