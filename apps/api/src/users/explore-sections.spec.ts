import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EXPLORE_SECTION_IDS, normalizeExploreSections } from '@tvwatch/shared';
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
