-- Add optional media card attachment to comments: (media_type, media_id) references
-- a media_items row (duck-typed, no FK, same convention as thread_id). Mutually
-- exclusive with image/GIF attachments, enforced in the service layer.
ALTER TABLE "comments"
  ADD COLUMN "media_type" "MediaType",
  ADD COLUMN "media_id" TEXT;
