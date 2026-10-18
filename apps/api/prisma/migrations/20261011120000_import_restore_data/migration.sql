-- Native TV Watch Time export restore: account-level state carried from staging to confirm.
ALTER TABLE "imports" ADD COLUMN IF NOT EXISTS "restore_data" JSONB;
