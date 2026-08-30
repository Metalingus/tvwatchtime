-- Additive authority-provider artwork galleries. Existing image rows are retained
-- with legacy source keys and are not eligible for gallery reads until rehydrated.
ALTER TABLE "media_items" ADD COLUMN "gallery_state" JSONB;
ALTER TABLE "episodes" ADD COLUMN "gallery_state" JSONB;

ALTER TABLE "images"
  ADD COLUMN "preview_url" TEXT,
  ADD COLUMN "provider" "ExternalProvider",
  ADD COLUMN "provider_entity_kind" "ProviderEntityKind",
  ADD COLUMN "provider_entity_id" TEXT,
  ADD COLUMN "provider_image_id" TEXT,
  ADD COLUMN "source_key" TEXT,
  ADD COLUMN "language" TEXT,
  ADD COLUMN "includes_text" BOOLEAN,
  ADD COLUMN "provider_rank" DOUBLE PRECISION,
  ADD COLUMN "sort_order" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "images" SET "source_key" = 'LEGACY:' || "id" WHERE "source_key" IS NULL;
ALTER TABLE "images" ALTER COLUMN "source_key" SET NOT NULL;

DROP INDEX IF EXISTS "images_media_id_kind_idx";
CREATE UNIQUE INDEX "images_media_id_source_key_key" ON "images"("media_id", "source_key");
CREATE INDEX "images_authority_order_idx"
  ON "images"("media_id", "provider", "provider_entity_kind", "provider_entity_id", "sort_order");

CREATE TABLE "episode_images" (
  "id" TEXT NOT NULL,
  "episode_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "preview_url" TEXT,
  "width" INTEGER,
  "height" INTEGER,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "provider" "ExternalProvider" NOT NULL,
  "provider_entity_kind" "ProviderEntityKind" NOT NULL DEFAULT 'EPISODE',
  "provider_entity_id" TEXT NOT NULL,
  "provider_image_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "language" TEXT,
  "includes_text" BOOLEAN,
  "provider_rank" DOUBLE PRECISION,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "episode_images_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "episode_images_episode_id_source_key_key"
  ON "episode_images"("episode_id", "source_key");
CREATE INDEX "episode_images_authority_order_idx"
  ON "episode_images"("episode_id", "provider", "provider_entity_kind", "provider_entity_id", "sort_order");
ALTER TABLE "episode_images" ADD CONSTRAINT "episode_images_episode_id_fkey"
  FOREIGN KEY ("episode_id") REFERENCES "episodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
