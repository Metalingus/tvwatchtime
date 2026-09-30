-- One concurrent index per migration for this repository's Prisma 5 PostgreSQL runner.
-- This lookup is used by identity inspection, copy verification and repair prioritization.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "user_show_status_media_id_idx" ON "user_show_status" ("media_id");
