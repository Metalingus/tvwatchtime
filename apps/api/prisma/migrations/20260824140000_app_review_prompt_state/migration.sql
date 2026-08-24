ALTER TABLE "users"
ADD COLUMN "app_review_prompted_at" TIMESTAMP(3),
ADD COLUMN "app_review_prompt_count" INTEGER NOT NULL DEFAULT 0;
