-- One concurrent index per migration for Prisma 5's PostgreSQL SQL runner.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "media_canonical_copies_mapping_key_key"
  ON "media_canonical_copies" ("mapping_key");
