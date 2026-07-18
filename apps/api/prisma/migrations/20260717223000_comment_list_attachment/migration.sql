-- Add optional list card attachment to comments: list_id references a custom_lists row
-- (duck-typed, no FK, same convention as thread_id/media_id). Mutually exclusive with
-- image/GIF/media attachments, enforced in the service layer.
ALTER TABLE "comments" ADD COLUMN "list_id" TEXT;
