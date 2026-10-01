-- WatchForge budget lanes and durable lookup ledger (M1). New empty tables only; no existing data changes.
-- CreateTable
CREATE TABLE "watchforge_lookups" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "wf_id" TEXT,
    "lane" TEXT NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watchforge_lookups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watchforge_usage_days" (
    "day" DATE NOT NULL,
    "lane" TEXT NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watchforge_usage_days_pkey" PRIMARY KEY ("day","lane")
);

-- CreateIndex
CREATE INDEX "watchforge_lookups_expires_at_idx" ON "watchforge_lookups"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "watchforge_lookups_provider_media_type_external_id_key" ON "watchforge_lookups"("provider", "media_type", "external_id");

