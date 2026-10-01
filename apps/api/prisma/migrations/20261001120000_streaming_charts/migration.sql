-- Streaming top charts reuse the Explore rail snapshot tables. Additive only: a new rail type
-- and a nullable partition key ("motn:<service>:<COUNTRY>") for typed rails.
ALTER TYPE "HydrationJobType" ADD VALUE IF NOT EXISTS 'streaming_top';
ALTER TABLE "hydration_jobs" ADD COLUMN IF NOT EXISTS "rail_key" TEXT;
