-- AlterTable
-- Monotonic revision counter so a background stats recompute can detect that a newer
-- invalidation superseded it (lost-update guard). Defaults to 0; only stats-affecting
-- mutations increment it.
-- IF NOT EXISTS so the step is safe to re-run if a deploy is retried (applied manually via
-- `prisma db execute`, which does not track applied migrations in _prisma_migrations).
ALTER TABLE "user_stats_summary" ADD COLUMN IF NOT EXISTS "dirty_version" INTEGER NOT NULL DEFAULT 0;

