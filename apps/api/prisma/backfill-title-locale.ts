import { PrismaClient } from '@prisma/client';

/**
 * One-off deploy migration for locale-aware metadata.
 *
 * Does two things, both idempotent:
 *  1. Ensures the localization columns exist (additive `JSONB`/`TEXT`, `IF NOT EXISTS`).
 *     This mirrors schema.prisma so the change can be applied even when
 *     `prisma db push` errors on unrelated schema drift (e.g. character_votes).
 *  2. Marks every existing `media_items.title_locale = 'en'`.
 *
 * All existing rows were hydrated under the English default (TMDB_LANGUAGE=en-US),
 * so their base `title`/`overview`/`posterUrl`/`backdropUrl` are already English.
 * Marking them the trusted English base prevents a one-time English re-fetch burst
 * for every media on its first post-deploy view. Season/episode/genre/cast base
 * columns are likewise English and their per-locale overrides are null, so the read
 * fallback (`override[lang] ?? override['en'] ?? base`) already returns English —
 * no backfill needed there.
 *
 * IMPORTANT: only run where the previous metadata language was English. If a server
 * ran with a non-English `TMDB_LANGUAGE`, leave title_locale NULL so the next hydrate
 * re-fetches the English base instead.
 *
 * Run locally:  `$env:DATABASE_URL="..."; pnpm --filter @tvwatch/api db:backfill-title-locale`
 * Run remote:   `docker compose ... run --rm api pnpm --filter @tvwatch/api db:backfill-title-locale`
 */
const DDL = [
  'ALTER TABLE media_items ADD COLUMN IF NOT EXISTS titles JSONB',
  'ALTER TABLE media_items ADD COLUMN IF NOT EXISTS overviews JSONB',
  'ALTER TABLE media_items ADD COLUMN IF NOT EXISTS poster_urls JSONB',
  'ALTER TABLE media_items ADD COLUMN IF NOT EXISTS backdrop_urls JSONB',
  'ALTER TABLE media_items ADD COLUMN IF NOT EXISTS title_locale TEXT',
  'ALTER TABLE seasons ADD COLUMN IF NOT EXISTS titles JSONB',
  'ALTER TABLE seasons ADD COLUMN IF NOT EXISTS overviews JSONB',
  'ALTER TABLE seasons ADD COLUMN IF NOT EXISTS poster_urls JSONB',
  'ALTER TABLE episodes ADD COLUMN IF NOT EXISTS titles JSONB',
  'ALTER TABLE episodes ADD COLUMN IF NOT EXISTS overviews JSONB',
  'ALTER TABLE episodes ADD COLUMN IF NOT EXISTS still_urls JSONB',
  'ALTER TABLE genres ADD COLUMN IF NOT EXISTS names JSONB',
  'ALTER TABLE media_cast ADD COLUMN IF NOT EXISTS characters JSONB',
];

async function main() {
  const prisma = new PrismaClient();
  try {
    console.log('Ensuring localization columns exist...');
    for (const sql of DDL) await prisma.$executeRawUnsafe(sql);

    const before = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*)::bigint AS count FROM media_items WHERE title_locale IS NULL
    `;
    const pending = Number(before[0]?.count ?? 0);
    console.log(`media_items with title_locale IS NULL: ${pending}`);

    if (pending === 0) {
      console.log('Nothing to backfill — all rows already have a title_locale.');
      return;
    }

    const result = await prisma.$executeRaw`
      UPDATE media_items SET title_locale = 'en' WHERE title_locale IS NULL
    `;
    console.log(`Marked ${result} media_items as trusted-English base (title_locale = 'en').`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
