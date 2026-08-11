-- The personalized candidate query filters by media type and takes the most popular
-- 600 rows before applying per-user affinity scoring. Prisma deploys this migration
-- transactionally, so these indexes intentionally do not use CONCURRENTLY.
CREATE INDEX IF NOT EXISTS "media_items_type_popularity_idx"
  ON "media_items" ("type", "popularity" DESC);

-- Candidate exclusion and taste aggregation are user+media lookups. Large imports can
-- otherwise make each personalized build revisit the user's whole history through two indexes.
CREATE INDEX IF NOT EXISTS "watch_history_user_media_idx"
  ON "watch_history" ("user_id", "media_id");
