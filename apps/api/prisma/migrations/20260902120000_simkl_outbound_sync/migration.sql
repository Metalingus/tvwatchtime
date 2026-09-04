-- Optional SIMKL outbound synchronization. The feature defaults off for every existing account.
ALTER TABLE "user_integrations"
  ADD COLUMN "outbound_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "outbound_status" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN "last_outbound_synced_at" TIMESTAMP(3),
  ADD COLUMN "last_outbound_error" TEXT,
  ADD COLUMN "outbound_bootstrap_at" TIMESTAMP(3);

CREATE TABLE "simkl_sync_item_states" (
  "id" TEXT NOT NULL,
  "integration_id" TEXT NOT NULL,
  "media_id" TEXT NOT NULL,
  "simkl_id" TEXT,
  "simkl_type" TEXT,
  "remote_state" JSONB,
  "managed_state" JSONB,
  "suppress_watchlist_echo" BOOLEAN NOT NULL DEFAULT false,
  "dirty" BOOLEAN NOT NULL DEFAULT false,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "sync_status" TEXT NOT NULL DEFAULT 'IDLE',
  "last_attempt_at" TIMESTAMP(3),
  "last_synced_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "simkl_sync_item_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "simkl_sync_item_states_integration_id_media_id_key"
  ON "simkl_sync_item_states"("integration_id", "media_id");
CREATE UNIQUE INDEX "simkl_sync_item_states_integration_id_simkl_id_key"
  ON "simkl_sync_item_states"("integration_id", "simkl_id");
CREATE INDEX "simkl_sync_item_states_integration_id_dirty_idx"
  ON "simkl_sync_item_states"("integration_id", "dirty");

ALTER TABLE "simkl_sync_item_states"
  ADD CONSTRAINT "simkl_sync_item_states_integration_id_fkey"
  FOREIGN KEY ("integration_id") REFERENCES "user_integrations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- SIMKL stores ratings on a 1..10 scale while TVWatch uses integer 1..5 stars. Previous
-- inbound syncs stored the raw SIMKL number. Repair only SIMKL-owned rows; manual and other
-- provider ratings keep their exact values.
UPDATE "ratings"
SET "rating" = CEIL("rating" / 2.0)::INTEGER
WHERE "source" = 'SIMKL'::"ListSource"
  AND "rating" BETWEEN 1 AND 10;
