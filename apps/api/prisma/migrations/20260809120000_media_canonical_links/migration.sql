CREATE TYPE "MediaCanonicalRelation" AS ENUM ('EXACT_DUPLICATE', 'SEASON_COMPONENT');
CREATE TYPE "MediaCanonicalStatus" AS ENUM ('COPYING', 'ACTIVE', 'FAILED');

CREATE TABLE "media_canonical_links" (
    "id" TEXT NOT NULL,
    "source_media_id" TEXT NOT NULL,
    "target_media_id" TEXT NOT NULL,
    "relation" "MediaCanonicalRelation" NOT NULL,
    "target_season_number" INTEGER,
    "status" "MediaCanonicalStatus" NOT NULL DEFAULT 'COPYING',
    "evidence" JSONB,
    "copy_report" JSONB,
    "last_error" TEXT,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "media_canonical_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "media_canonical_copies" (
    "id" TEXT NOT NULL,
    "link_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_canonical_copies_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "media_canonical_links"
    ADD CONSTRAINT "media_canonical_links_distinct_media_check"
    CHECK ("source_media_id" <> "target_media_id");

CREATE UNIQUE INDEX "media_canonical_links_source_media_id_key"
    ON "media_canonical_links"("source_media_id");
CREATE INDEX "media_canonical_links_target_media_id_status_idx"
    ON "media_canonical_links"("target_media_id", "status");
CREATE INDEX "media_canonical_links_status_updated_at_idx"
    ON "media_canonical_links"("status", "updated_at");

CREATE UNIQUE INDEX "media_canonical_copies_link_id_entity_type_source_id_key"
    ON "media_canonical_copies"("link_id", "entity_type", "source_id");
CREATE INDEX "media_canonical_copies_entity_type_source_id_idx"
    ON "media_canonical_copies"("entity_type", "source_id");
CREATE INDEX "media_canonical_copies_entity_type_target_id_idx"
    ON "media_canonical_copies"("entity_type", "target_id");

ALTER TABLE "media_canonical_links"
    ADD CONSTRAINT "media_canonical_links_source_media_id_fkey"
    FOREIGN KEY ("source_media_id") REFERENCES "media_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_canonical_links"
    ADD CONSTRAINT "media_canonical_links_target_media_id_fkey"
    FOREIGN KEY ("target_media_id") REFERENCES "media_items"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "media_canonical_copies"
    ADD CONSTRAINT "media_canonical_copies_link_id_fkey"
    FOREIGN KEY ("link_id") REFERENCES "media_canonical_links"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
