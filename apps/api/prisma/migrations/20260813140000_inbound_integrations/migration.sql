-- Additive provider provenance values for imported ratings/reactions.
ALTER TYPE "ListSource" ADD VALUE IF NOT EXISTS 'SIMKL';
ALTER TYPE "ListSource" ADD VALUE IF NOT EXISTS 'STREMIO';
ALTER TYPE "ListSource" ADD VALUE IF NOT EXISTS 'JELLYFIN';

CREATE TYPE "IntegrationProvider" AS ENUM ('SIMKL', 'STREMIO', 'JELLYFIN');

CREATE TABLE "user_integrations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "credentials_encrypted" TEXT NOT NULL,
    "external_user_id" TEXT,
    "display_name" TEXT,
    "server_url" TEXT,
    "sync_cursor" JSONB,
    "connected_at" TIMESTAMP(3),
    "last_synced_at" TIMESTAMP(3),
    "last_sync_status" TEXT NOT NULL DEFAULT 'IDLE',
    "last_sync_error" TEXT,
    "last_import_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_integrations_user_id_provider_key"
    ON "user_integrations"("user_id", "provider");
CREATE INDEX "user_integrations_user_id_idx" ON "user_integrations"("user_id");
CREATE INDEX "user_integrations_provider_last_synced_at_idx"
    ON "user_integrations"("provider", "last_synced_at");

ALTER TABLE "user_integrations"
    ADD CONSTRAINT "user_integrations_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
