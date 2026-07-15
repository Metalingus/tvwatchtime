-- Multi-provider identity namespaces + classification + provenance + snapshots
-- Data-migrating: backfills provider_entity_kind from media type before enforcing it.

-- 1) New ExternalProvider members
ALTER TYPE "ExternalProvider" ADD VALUE IF NOT EXISTS 'KITSU';
ALTER TYPE "ExternalProvider" ADD VALUE IF NOT EXISTS 'MYANIME_LIST';

-- 2) New enums
DO $$ BEGIN
  CREATE TYPE "ProviderEntityKind" AS ENUM ('SERIES', 'MOVIE', 'EPISODE', 'SEASON', 'ANIME', 'MANGA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContentClassification" AS ENUM ('GENERAL', 'ANIME', 'MANGA', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3) external_ids: add namespace column, backfill from media type, NOT NULL, swap unique
ALTER TABLE "external_ids" ADD COLUMN IF NOT EXISTS "provider_entity_kind" "ProviderEntityKind";
UPDATE "external_ids" e
  SET "provider_entity_kind" =
    CASE WHEN m.type = 'SHOW' THEN 'SERIES'::"ProviderEntityKind" ELSE 'MOVIE'::"ProviderEntityKind" END
  FROM "media_items" m
  WHERE m.id = e.media_id;
ALTER TABLE "external_ids" ALTER COLUMN "provider_entity_kind" SET NOT NULL;
DROP INDEX IF EXISTS "external_ids_provider_value_key";
CREATE UNIQUE INDEX IF NOT EXISTS "external_ids_provider_provider_entity_kind_value_key"
  ON "external_ids" ("provider", "provider_entity_kind", "value");

-- 4) episode_external_ids (episode-level external identities, e.g. TVDB episode id)
CREATE TABLE IF NOT EXISTS "episode_external_ids" (
  "id" TEXT NOT NULL,
  "episode_id" TEXT NOT NULL,
  "provider" "ExternalProvider" NOT NULL,
  "provider_entity_kind" "ProviderEntityKind" NOT NULL DEFAULT 'EPISODE',
  "value" TEXT NOT NULL,
  "url" TEXT,
  CONSTRAINT "episode_external_ids_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "episode_external_ids_episode_id_idx" ON "episode_external_ids"("episode_id");
CREATE UNIQUE INDEX IF NOT EXISTS "episode_external_ids_provider_provider_entity_kind_value_key"
  ON "episode_external_ids" ("provider", "provider_entity_kind", "value");
ALTER TABLE "episode_external_ids"
  ADD CONSTRAINT "episode_external_ids_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) media_items: classification + provenance columns (backfilled GENERAL/default)
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "content_classification" "ContentClassification" NOT NULL DEFAULT 'GENERAL';
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "classification_confidence" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "classification_tier" TEXT;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "classified_at" TIMESTAMP(3);
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "classification_evidence" JSONB;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "manual_classification" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "manual_candidate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "media_items" ADD COLUMN IF NOT EXISTS "metadata_provenance" JSONB;

-- 6) provider snapshots (media + episode scoped; single required FK owner — no polymorphism)
CREATE TABLE IF NOT EXISTS "media_provider_snapshots" (
  "id" TEXT NOT NULL,
  "media_id" TEXT NOT NULL,
  "provider" "ExternalProvider" NOT NULL,
  "provider_entity_kind" "ProviderEntityKind" NOT NULL,
  "kind" TEXT NOT NULL,
  "locale" TEXT,
  "payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "media_provider_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "media_provider_snapshots_media_id_idx" ON "media_provider_snapshots"("media_id");
CREATE UNIQUE INDEX IF NOT EXISTS "media_provider_snapshots_media_id_provider_provider_entity_kind_kind_locale_key"
  ON "media_provider_snapshots" ("media_id", "provider", "provider_entity_kind", "kind", "locale");
ALTER TABLE "media_provider_snapshots"
  ADD CONSTRAINT "media_provider_snapshots_media_id_fkey"
  FOREIGN KEY ("media_id") REFERENCES "media_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "episode_provider_snapshots" (
  "id" TEXT NOT NULL,
  "episode_id" TEXT NOT NULL,
  "provider" "ExternalProvider" NOT NULL,
  "provider_entity_kind" "ProviderEntityKind" NOT NULL DEFAULT 'EPISODE',
  "kind" TEXT NOT NULL,
  "locale" TEXT,
  "payload" JSONB NOT NULL,
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "episode_provider_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "episode_provider_snapshots_episode_id_idx" ON "episode_provider_snapshots"("episode_id");
CREATE UNIQUE INDEX IF NOT EXISTS "episode_provider_snapshots_episode_id_provider_provider_entity_kind_kind_locale_key"
  ON "episode_provider_snapshots" ("episode_id", "provider", "provider_entity_kind", "kind", "locale");
ALTER TABLE "episode_provider_snapshots"
  ADD CONSTRAINT "episode_provider_snapshots_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
