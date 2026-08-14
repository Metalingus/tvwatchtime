-- Per-integration controls and source-aware ownership for reversible inbound sync.
ALTER TABLE "user_integrations"
  ADD COLUMN "paused" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "items_disabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "sync_settings" JSONB;

ALTER TABLE "user_episode_status"
  ADD COLUMN "source" "ListSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_key" TEXT;
ALTER TABLE "user_movie_status"
  ADD COLUMN "source" "ListSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_key" TEXT;
ALTER TABLE "watch_history"
  ADD COLUMN "source" "ListSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_key" TEXT;
ALTER TABLE "watchlist_items"
  ADD COLUMN "source" "ListSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_key" TEXT;
ALTER TABLE "favorites"
  ADD COLUMN "source" "ListSource" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "source_key" TEXT;

CREATE INDEX "user_episode_status_user_id_source_source_key_idx"
  ON "user_episode_status"("user_id", "source", "source_key");
CREATE INDEX "user_movie_status_user_id_source_source_key_idx"
  ON "user_movie_status"("user_id", "source", "source_key");
CREATE INDEX "watch_history_user_id_source_source_key_idx"
  ON "watch_history"("user_id", "source", "source_key");
CREATE INDEX "watchlist_items_user_id_source_source_key_idx"
  ON "watchlist_items"("user_id", "source", "source_key");
CREATE INDEX "favorites_user_id_source_source_key_idx"
  ON "favorites"("user_id", "source", "source_key");

CREATE TABLE "integration_synced_items" (
  "id" TEXT NOT NULL,
  "integration_id" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "entity_type" "ImportEntityType" NOT NULL,
  "media_id" TEXT,
  "episode_id" TEXT,
  "target_record_id" TEXT,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "integration_synced_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "integration_synced_items_integration_id_source_key_key"
  ON "integration_synced_items"("integration_id", "source_key");
CREATE INDEX "integration_synced_items_integration_id_entity_type_idx"
  ON "integration_synced_items"("integration_id", "entity_type");
CREATE INDEX "integration_synced_items_entity_type_media_id_episode_id_idx"
  ON "integration_synced_items"("entity_type", "media_id", "episode_id");

ALTER TABLE "integration_synced_items"
  ADD CONSTRAINT "integration_synced_items_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "user_integrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing imported records defaulted to MANUAL above. Recover provider ownership only for
-- records the import audit proves were created by an inbound provider. Pre-existing TVWatch
-- or TV Time records were skipped by those imports and therefore keep authority.
CREATE TEMP TABLE "_integration_owned_records" AS
SELECT DISTINCT ON (iar."target_table", iar."target_record_id")
  iar."target_table",
  iar."target_record_id",
  CASE lower(i."format")
    WHEN 'simkl' THEN 'SIMKL'::"ListSource"
    WHEN 'stremio' THEN 'STREMIO'::"ListSource"
    WHEN 'jellyfin' THEN 'JELLYFIN'::"ListSource"
  END AS "source",
  COALESCE(ii."raw_data"->>'sourceKey', ii."normalized_data"->>'voteKey') AS "source_key"
FROM "import_applied_records" iar
JOIN "imports" i ON i."id" = iar."import_id"
LEFT JOIN "import_items" ii ON ii."id" = iar."import_item_id"
WHERE iar."action" = 'created'
  AND lower(i."format") IN ('simkl', 'stremio', 'jellyfin')
ORDER BY iar."target_table", iar."target_record_id", iar."created_at" DESC;

UPDATE "user_episode_status" target
SET "source" = owned."source", "source_key" = owned."source_key"
FROM "_integration_owned_records" owned
WHERE owned."target_table" = 'user_episode_status'
  AND owned."target_record_id" = target."id";

UPDATE "user_movie_status" target
SET "source" = owned."source", "source_key" = owned."source_key"
FROM "_integration_owned_records" owned
WHERE owned."target_table" = 'user_movie_status'
  AND owned."target_record_id" = target."id";

UPDATE "watchlist_items" target
SET "source" = owned."source", "source_key" = owned."source_key"
FROM "_integration_owned_records" owned
WHERE owned."target_table" = 'watchlist_items'
  AND owned."target_record_id" = target."id";

UPDATE "favorites" target
SET "source" = owned."source", "source_key" = owned."source_key"
FROM "_integration_owned_records" owned
WHERE owned."target_table" = 'favorites'
  AND owned."target_record_id" = target."id";

UPDATE "ratings" target
SET "source_key" = COALESCE(target."source_key", owned."source_key")
FROM "_integration_owned_records" owned
WHERE owned."target_table" = 'ratings'
  AND owned."target_record_id" = target."id";

-- Watch-history rows were historically created beside statuses without their own audit row.
-- Match the first-watch row back to its audited status; manual/TVTIME rows stay untouched.
UPDATE "watch_history" history
SET "source" = status."source", "source_key" = status."source_key"
FROM "user_episode_status" status
WHERE history."user_id" = status."user_id"
  AND history."episode_id" = status."episode_id"
  AND history."watched_at" = status."watched_at"
  AND status."source" IN ('SIMKL', 'STREMIO', 'JELLYFIN');

UPDATE "watch_history" history
SET "source" = status."source", "source_key" = status."source_key"
FROM "user_movie_status" status
WHERE history."user_id" = status."user_id"
  AND history."media_id" = status."media_id"
  AND history."media_type" = 'MOVIE'
  AND history."watched_at" = status."watched_at"
  AND status."source" IN ('SIMKL', 'STREMIO', 'JELLYFIN');

-- Recover contribution rows for previous syncs, including items that were skipped because an
-- authoritative TVWatch/TV Time record already existed.
INSERT INTO "integration_synced_items" (
  "id", "integration_id", "source_key", "entity_type", "media_id", "episode_id",
  "first_seen_at", "last_seen_at"
)
SELECT DISTINCT ON (ui."id", ii."raw_data"->>'sourceKey')
  md5(ui."id" || ':' || (ii."raw_data"->>'sourceKey')),
  ui."id",
  ii."raw_data"->>'sourceKey',
  ii."source_entity_type",
  ii."matched_media_id",
  ii."matched_episode_id",
  i."created_at",
  i."created_at"
FROM "imports" i
JOIN "import_items" ii ON ii."import_id" = i."id"
JOIN "user_integrations" ui
  ON ui."user_id" = i."user_id"
  AND ui."provider"::text = upper(i."format")
WHERE lower(i."format") IN ('simkl', 'stremio', 'jellyfin')
  AND i."status" = 'COMPLETED'
  AND ii."matched_media_id" IS NOT NULL
  AND ii."raw_data"->>'sourceKey' IS NOT NULL
ORDER BY ui."id", ii."raw_data"->>'sourceKey', i."created_at" DESC
ON CONFLICT ("integration_id", "source_key") DO NOTHING;

UPDATE "integration_synced_items" item
SET "target_record_id" = target."id"
FROM "user_episode_status" target, "user_integrations" ui
WHERE item."integration_id" = ui."id"
  AND item."entity_type" = 'WATCHED_EPISODE'
  AND target."user_id" = ui."user_id"
  AND target."episode_id" = item."episode_id";

UPDATE "integration_synced_items" item
SET "target_record_id" = target."id"
FROM "user_movie_status" target, "user_integrations" ui
WHERE item."integration_id" = ui."id"
  AND item."entity_type" = 'WATCHED_MOVIE'
  AND target."user_id" = ui."user_id"
  AND target."media_id" = item."media_id";

UPDATE "integration_synced_items" item
SET "target_record_id" = target."id"
FROM "watchlist_items" target, "user_integrations" ui
WHERE item."integration_id" = ui."id"
  AND item."entity_type" IN ('WATCHLIST_SHOW', 'WATCHLIST_MOVIE')
  AND target."user_id" = ui."user_id"
  AND target."media_id" = item."media_id";

UPDATE "integration_synced_items" item
SET "target_record_id" = target."id"
FROM "favorites" target, "user_integrations" ui
WHERE item."integration_id" = ui."id"
  AND item."entity_type" IN ('FAVORITE_SHOW', 'FAVORITE_MOVIE')
  AND target."user_id" = ui."user_id"
  AND target."media_id" = item."media_id";

UPDATE "integration_synced_items" item
SET "target_record_id" = target."id"
FROM "ratings" target, "user_integrations" ui
WHERE item."integration_id" = ui."id"
  AND item."entity_type" IN ('SHOW_RATING', 'MOVIE_RATING', 'EPISODE_RATING')
  AND target."user_id" = ui."user_id"
  AND (
    (item."episode_id" IS NOT NULL AND target."episode_id" = item."episode_id") OR
    (item."episode_id" IS NULL AND target."media_id" = item."media_id")
  );
