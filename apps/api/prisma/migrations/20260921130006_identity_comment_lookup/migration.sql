-- One concurrent index per migration for this repository's Prisma 5 PostgreSQL runner.
-- This lookup is used by identity inspection, copy verification and repair prioritization.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "comments_media_id_idx" ON "comments" ("media_id");
