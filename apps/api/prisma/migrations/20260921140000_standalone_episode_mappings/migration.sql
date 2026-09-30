-- Reuse the existing copy ledger for same-media episode remaps.
-- Existing canonical-family rows keep their link and are unchanged.
ALTER TABLE "media_canonical_copies"
  ALTER COLUMN "link_id" DROP NOT NULL,
  ADD COLUMN "mapping_key" TEXT,
  ADD COLUMN "evidence" JSONB;
ALTER TABLE "media_canonical_copies"
  ADD CONSTRAINT "standalone_episode_mapping_evidence"
  CHECK ("link_id" IS NOT NULL OR
    ("mapping_key" IS NOT NULL AND COALESCE("evidence"->>'kind','')='verified-episode-remap'
      AND ("entity_type"='EPISODE' OR "entity_type" LIKE 'EPISODE:split:%'
        OR "entity_type"='EPISODE_ALIAS' OR "entity_type" LIKE 'EPISODE_ALIAS:split:%')));
