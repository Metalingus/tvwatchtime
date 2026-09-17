import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaVotesService } from '../common/media-votes.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MediaMetadataModule } from '../media-metadata/media-metadata.module';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { StructureRemapService } from '../media-metadata/structure-remap.service';
import { TmdbProvider } from '../media-metadata/providers/tmdb.provider';
import { TvdbProvider } from '../media-metadata/providers/tvdb.provider';
import { CommsUniModule } from './commsuni.module';
import { CommsUniPublicationService } from './commsuni.publication.service';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useValue: { get: (key: string) => (key === 'nodeEnv' ? 'test' : undefined) },
    },
    { provide: PrismaService, useValue: {} },
    { provide: RedisService, useValue: {} },
    { provide: EventEmitter2, useValue: { emit: jest.fn() } },
    MediaVotesService,
  ],
  exports: [ConfigService, PrismaService, RedisService, EventEmitter2, MediaVotesService],
})
class TestCore {}

@Module({
  providers: [MediaCanonicalizationService, StructureRemapService, TmdbProvider, TvdbProvider].map(
    (provide) => ({ provide, useValue: {} }),
  ),
  exports: [MediaCanonicalizationService, StructureRemapService, TmdbProvider, TvdbProvider],
})
class FakeMetadata {}

it('boots the disabled integration without database, Redis, provider writes, or a circular global vote dependency', async () => {
  const module = await Test.createTestingModule({ imports: [TestCore, CommsUniModule] })
    .overrideModule(MediaMetadataModule)
    .useModule(FakeMetadata)
    .compile();
  await module.init();
  expect(module.get(CommsUniPublicationService).client.writesEnabled).toBe(false);
  expect(module.get(MediaVotesService)).toBeDefined();
  await module.close();
});
