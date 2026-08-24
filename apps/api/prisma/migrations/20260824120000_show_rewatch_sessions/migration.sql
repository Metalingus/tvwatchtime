ALTER TABLE "user_show_status"
ADD COLUMN "rewatch_started_at" TIMESTAMP(3);

CREATE INDEX "user_show_status_rewatch_idx"
ON "user_show_status"("user_id", "rewatch_started_at");
