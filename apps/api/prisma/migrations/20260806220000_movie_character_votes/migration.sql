-- Extend favorite-character voting from episodes to movies without rewriting existing votes.
ALTER TYPE "ImportEntityType" ADD VALUE IF NOT EXISTS 'MOVIE_CHARACTER_VOTE';

ALTER TABLE "character_votes"
  ALTER COLUMN "episode_id" DROP NOT NULL,
  ADD COLUMN "media_id" TEXT;

CREATE UNIQUE INDEX "character_votes_user_id_media_id_key"
  ON "character_votes"("user_id", "media_id");
CREATE INDEX "character_votes_media_id_idx" ON "character_votes"("media_id");

ALTER TABLE "character_votes"
  ADD CONSTRAINT "character_votes_media_id_fkey"
  FOREIGN KEY ("media_id") REFERENCES "media_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "character_votes"
  ADD CONSTRAINT "character_votes_exactly_one_target_check"
  CHECK (num_nonnulls("episode_id", "media_id") = 1);

-- A cast credit may have several provider role aliases. Identity is scoped to the media
-- because one TV Time synthetic-series role can map onto several individual movies.
CREATE TABLE "media_cast_external_ids" (
  "id" TEXT NOT NULL,
  "media_id" TEXT NOT NULL,
  "cast_id" TEXT NOT NULL,
  "provider" "ExternalProvider" NOT NULL,
  "value" TEXT NOT NULL,
  CONSTRAINT "media_cast_external_ids_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "media_cast_external_ids_media_id_provider_value_key"
  ON "media_cast_external_ids"("media_id", "provider", "value");
CREATE INDEX "media_cast_external_ids_cast_id_idx"
  ON "media_cast_external_ids"("cast_id");

ALTER TABLE "media_cast_external_ids"
  ADD CONSTRAINT "media_cast_external_ids_media_id_fkey"
  FOREIGN KEY ("media_id") REFERENCES "media_items"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_cast_external_ids"
  ADD CONSTRAINT "media_cast_external_ids_cast_id_fkey"
  FOREIGN KEY ("cast_id") REFERENCES "media_cast"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve every existing TVDB role id as an indexed alias. If historical duplicate credits
-- share an id, prefer the row already carrying the most user votes.
INSERT INTO "media_cast_external_ids" ("id", "media_id", "cast_id", "provider", "value")
SELECT
  'mcx_' || md5(r."media_id" || ':THE_TVDB:' || r."character_external_id"::text),
  r."media_id",
  r."id",
  'THE_TVDB'::"ExternalProvider",
  r."character_external_id"::text
FROM (
  SELECT mc.*,
         ROW_NUMBER() OVER (
           PARTITION BY mc."media_id", mc."character_external_id"
           ORDER BY (
             SELECT count(*) FROM "character_votes" cv WHERE cv."cast_id" = mc."id"
           ) DESC, mc."id"
         ) AS rn
  FROM "media_cast" mc
  WHERE mc."character_external_id" IS NOT NULL
) r
WHERE r.rn = 1
ON CONFLICT ("media_id", "provider", "value") DO NOTHING;
