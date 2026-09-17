-- Additive only. No existing/imported comment becomes eligible for publication.
ALTER TABLE "comments"
  ADD COLUMN "commsuni_origin_id" TEXT,
  ADD COLUMN "commsuni_comment_id" TEXT,
  ADD COLUMN "commsuni_entity_id" TEXT,
  ADD COLUMN "commsuni_parent_id" TEXT,
  ADD COLUMN "commsuni_state" TEXT,
  ADD COLUMN "client_action_id" TEXT;
CREATE UNIQUE INDEX "comments_commsuni_comment_id_key" ON "comments"("commsuni_comment_id");
CREATE UNIQUE INDEX "comments_client_action_id_key" ON "comments"("client_action_id");
CREATE INDEX "comments_commsuni_origin_id_idx" ON "comments"("commsuni_origin_id");
CREATE INDEX "comments_commsuni_parent_id_idx" ON "comments"("commsuni_parent_id");
CREATE TABLE "commsuni_bindings" (
  "id" TEXT PRIMARY KEY, "scope" TEXT NOT NULL, "thread_type" "CommentThreadType" NOT NULL,
  "thread_id" TEXT NOT NULL, "entity_type" TEXT NOT NULL, "reference" TEXT NOT NULL,
  "entity_id" TEXT, "fingerprint" TEXT NOT NULL, "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "commsuni_bindings_scope_thread_type_thread_id_key" ON "commsuni_bindings"("scope", "thread_type", "thread_id");
CREATE INDEX "commsuni_bindings_entity_id_idx" ON "commsuni_bindings"("entity_id");
CREATE TABLE "commsuni_identities" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "scope" TEXT NOT NULL, "actor_encrypted" TEXT NOT NULL, "author_id" TEXT, "profile_hash" TEXT,
  "deleting" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "commsuni_identities_user_id_scope_key" ON "commsuni_identities"("user_id", "scope");
CREATE INDEX "commsuni_identities_scope_author_id_idx" ON "commsuni_identities"("scope", "author_id");
CREATE TABLE "commsuni_outbox" (
  "id" TEXT PRIMARY KEY, "identity_id" TEXT NOT NULL REFERENCES "commsuni_identities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "dedupe_key" TEXT NOT NULL, "comment_id" TEXT, "method" TEXT NOT NULL, "path" TEXT NOT NULL,
  "payload" TEXT NOT NULL, "target" JSONB, "state" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0, "first_attempt_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "remote_id" TEXT,
  "error_code" TEXT, "cleanup" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "commsuni_outbox_dedupe_key_key" ON "commsuni_outbox"("dedupe_key");
CREATE INDEX "commsuni_outbox_state_next_attempt_at_idx" ON "commsuni_outbox"("state", "next_attempt_at");
CREATE INDEX "commsuni_outbox_comment_id_idx" ON "commsuni_outbox"("comment_id");
CREATE TABLE "commsuni_author_blocks" (
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scope" TEXT NOT NULL, "author_id" TEXT NOT NULL, "name" TEXT NOT NULL,
  PRIMARY KEY ("user_id", "scope", "author_id")
);
CREATE TABLE "commsuni_reports" (
  "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "scope" TEXT NOT NULL, "comment_id" TEXT NOT NULL, "entity_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'OPEN', "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "commsuni_reports_user_id_scope_comment_id_key" ON "commsuni_reports"("user_id", "scope", "comment_id");
CREATE INDEX "commsuni_reports_state_created_at_idx" ON "commsuni_reports"("state", "created_at");
