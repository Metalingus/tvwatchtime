-- Additive delivery evidence only. No provider calls and no changes to existing user votes.
-- The receipt has no identity/user FK so deleting credentials cannot make preserved votes count twice.
CREATE TABLE "commsuni_vote_receipts" (
  "id" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "actor_digest" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "reference" TEXT NOT NULL,
  "entity_id" TEXT,
  "kind" TEXT NOT NULL,
  "selected_keys" JSONB NOT NULL,
  "sequence" BIGINT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commsuni_vote_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commsuni_vote_receipts_keys_array" CHECK (jsonb_typeof("selected_keys") = 'array')
);
CREATE UNIQUE INDEX "commsuni_vote_receipts_actor_entity_kind_key"
  ON "commsuni_vote_receipts"("scope", "actor_digest", "entity_type", "reference", "kind");
CREATE INDEX "commsuni_vote_receipts_scope_entity_type_reference_idx"
  ON "commsuni_vote_receipts"("scope", "entity_type", "reference");
CREATE INDEX "commsuni_vote_receipts_scope_entity_id_idx"
  ON "commsuni_vote_receipts"("scope", "entity_id");
