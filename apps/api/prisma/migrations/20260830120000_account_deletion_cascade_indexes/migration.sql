-- Account deletion cascades through these foreign keys. Without indexes PostgreSQL scans the
-- entire referencing table for each deleted parent row, which is especially expensive for
-- imported accounts with many import files/items.
--
-- This deployment path wraps migrations in a transaction, so these indexes must use regular
-- CREATE INDEX. IF NOT EXISTS keeps a retry safe if an environment created any index manually.
CREATE INDEX IF NOT EXISTS "import_items_import_file_id_idx"
  ON "import_items"("import_file_id");

CREATE INDEX IF NOT EXISTS "list_likes_list_id_idx"
  ON "list_likes"("list_id");

CREATE INDEX IF NOT EXISTS "list_subscriptions_list_id_idx"
  ON "list_subscriptions"("list_id");

CREATE INDEX IF NOT EXISTS "reports_reporter_id_idx"
  ON "reports"("reporter_id");

CREATE INDEX IF NOT EXISTS "reports_comment_id_idx"
  ON "reports"("comment_id");

CREATE INDEX IF NOT EXISTS "reports_comment_image_id_idx"
  ON "reports"("comment_image_id");
