-- Add nullable gif_url column to comments. Stores the final GIPHY media URL only;
-- no binary data, no metadata. Existing rows default to NULL (backward compatible).
ALTER TABLE "comments" ADD COLUMN "gif_url" TEXT;
