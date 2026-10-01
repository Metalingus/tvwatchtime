-- One concurrent index per migration for this repository's Prisma 5 PostgreSQL runner.
-- Latest completed snapshot per streaming chart rail.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "hydration_jobs_type_rail_key_status_completed_at_idx" ON "hydration_jobs" ("type", "rail_key", "status", "completed_at");
