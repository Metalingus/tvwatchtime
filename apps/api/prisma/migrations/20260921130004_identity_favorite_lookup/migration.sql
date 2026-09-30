-- One concurrent index per migration for this repository's Prisma 5 PostgreSQL runner.
-- This lookup is used by identity inspection, copy verification and repair prioritization.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "favorites_media_id_idx" ON "favorites" ("media_id");
