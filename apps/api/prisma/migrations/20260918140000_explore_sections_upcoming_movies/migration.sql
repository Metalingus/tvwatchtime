-- Additive account preference. Existing accounts use the default section layout.
ALTER TABLE "user_profiles" ADD COLUMN "explore_sections" JSONB;

-- Provision the weekly Upcoming Movies snapshot without changing any existing
-- schedule of this type (including an intentionally disabled/custom schedule).
INSERT INTO "scheduled_hydrations"
  ("id", "type", "label", "schedule", "timezone", "pages", "enabled", "created_at", "updated_at")
SELECT
  'default-upcoming-movies', 'upcoming_movies', 'Upcoming Movies',
  '0 3 * * 1', 'UTC', 1, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "scheduled_hydrations" WHERE "type" = 'upcoming_movies'
)
ON CONFLICT ("id") DO NOTHING;
