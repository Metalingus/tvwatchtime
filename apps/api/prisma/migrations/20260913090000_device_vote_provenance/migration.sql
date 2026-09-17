-- Additive only; run before deploying the API that reads device_source.
-- Preserve the currently recorded provenance. Do not infer or rewrite historical user choices.
ALTER TABLE "user_episode_status" ADD COLUMN "device_source" "ListSource";
ALTER TABLE "user_movie_status" ADD COLUMN "device_source" "ListSource";
UPDATE "user_episode_status" SET "device_source" = "source" WHERE "device" IS NOT NULL;
UPDATE "user_movie_status" SET "device_source" = "source" WHERE "device" IS NOT NULL;
CREATE INDEX "user_episode_status_episode_device_source_idx"
  ON "user_episode_status" ("episode_id", "device_source");
