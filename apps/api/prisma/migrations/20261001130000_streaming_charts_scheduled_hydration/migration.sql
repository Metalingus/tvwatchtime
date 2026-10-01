-- Streaming top charts run as a Scheduled Hydration row instead of a Scheduled Job.
-- 1. Per-row options (only the streaming_top row uses them; null = defaults).
ALTER TABLE "scheduled_hydrations" ADD COLUMN IF NOT EXISTS "config" JSONB;

-- 2. Provision the daily chart row, disabled: it spends a hard monthly provider quota and needs
--    MOTN_API_KEY. An existing row of this type (custom schedule/options) is left untouched.
INSERT INTO "scheduled_hydrations"
  ("id", "type", "label", "schedule", "timezone", "pages", "enabled", "config", "created_at", "updated_at")
SELECT
  'default-streaming-top', 'streaming_top', 'Streaming Top Charts',
  '30 6 * * *', 'UTC', 1, false,
  '{"countries":["US"],"services":["netflix","prime","disney","apple","hbo"],"monthlyBudget":1000,"reserve":20,"watchforge":true,"retentionDays":14}'::jsonb,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "scheduled_hydrations" WHERE "type" = 'streaming_top'
)
ON CONFLICT ("id") DO NOTHING;

-- 3. Retire the interim Scheduled Job definition (its run history cascades). No media,
--    chart snapshots or user data are touched.
DELETE FROM "cron_jobs" WHERE "name" = 'streaming_charts';
