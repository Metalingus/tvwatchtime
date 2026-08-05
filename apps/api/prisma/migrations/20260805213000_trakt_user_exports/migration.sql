-- Store compressed user exports in shared PostgreSQL storage so download links
-- continue to work when the request reaches a different API replica.
ALTER TABLE "data_exports"
ADD COLUMN "content_type" TEXT NOT NULL DEFAULT 'application/json',
ADD COLUMN "payload" BYTEA;

-- Existing cached totals may predate imported rewatch reconciliation.
UPDATE "user_stats_summary"
SET "stale" = TRUE,
    "dirty_version" = "dirty_version" + 1;
