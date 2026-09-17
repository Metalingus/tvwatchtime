-- Preserve older clients' local revisions and keep published attachment URLs stable.
ALTER TABLE "comments"
  ADD COLUMN "has_local_revision" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "client_request_hash" TEXT;

ALTER TABLE "comment_images"
  ADD COLUMN "retained_comment_id" TEXT;

-- Existing published/queued image snapshots must survive a later local-only replacement.
UPDATE "comment_images" AS image
SET "retained_comment_id" = image."comment_id"
FROM "comments" AS comment
WHERE comment."id" = image."comment_id"
  AND image."status" = 'ready'
  AND (
    comment."commsuni_comment_id" IS NOT NULL
    OR (
      comment."commsuni_state" IS NOT NULL
      AND comment."commsuni_state" NOT IN ('WAITING_ATTACHMENT', 'CANCELED')
    )
  );

ALTER TABLE "comment_images"
  ALTER COLUMN "comment_id" DROP NOT NULL,
  ADD CONSTRAINT "comment_images_retained_comment_id_fkey"
    FOREIGN KEY ("retained_comment_id") REFERENCES "comments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "comment_images_has_owner_check"
    CHECK ("comment_id" IS NOT NULL OR "retained_comment_id" IS NOT NULL),
  ADD CONSTRAINT "comment_images_same_owner_check"
    CHECK (
      "comment_id" IS NULL OR "retained_comment_id" IS NULL
      OR "comment_id" = "retained_comment_id"
    );

CREATE INDEX "comment_images_retained_comment_id_idx"
  ON "comment_images"("retained_comment_id");

-- Shared pages check only the small set of locally revised rows.
CREATE INDEX "comments_local_revision_thread_idx"
  ON "comments"("thread_type", "thread_id")
  WHERE "has_local_revision" = true;
