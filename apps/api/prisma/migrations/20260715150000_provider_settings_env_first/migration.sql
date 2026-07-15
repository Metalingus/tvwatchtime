-- Migration C: clear the provider resilience/secret settings rows that were seeded with
-- hardcoded defaults (which shadowed .env). After this, ProviderConfigService resolves each
-- provider config as (admin-console override > .env > safe default), so .env is authoritative.
-- Safe/idempotent: only removes the keys introduced by the multi-provider work.
DELETE FROM "app_settings"
WHERE "key" IN (
  'TVDB_ENABLED','TVDB_API_KEY','TVDB_PIN','TVDB_REQUESTS_PER_SECOND','TVDB_REQUESTS_PER_MINUTE',
  'TVDB_CONCURRENCY','TVDB_TIMEOUT_MS','TVDB_MAX_RETRIES','TVDB_BACKOFF_BASE_MS','TVDB_BACKOFF_MAX_MS',
  'TVDB_CACHE_TTL_SECONDS','TVDB_NEGATIVE_CACHE_TTL_SECONDS',
  'KITSU_ENABLED','KITSU_BASE_URL','KITSU_API_MODE','KITSU_REQUESTS_PER_SECOND','KITSU_REQUESTS_PER_MINUTE',
  'KITSU_CONCURRENCY','KITSU_TIMEOUT_MS','KITSU_MAX_RETRIES','KITSU_BACKOFF_BASE_MS','KITSU_BACKOFF_MAX_MS',
  'KITSU_CACHE_TTL_SECONDS',
  'JIKAN_ENABLED','JIKAN_BASE_URL','JIKAN_PUBLIC_FALLBACK','JIKAN_REQUESTS_PER_SECOND','JIKAN_REQUESTS_PER_MINUTE',
  'JIKAN_CONCURRENCY','JIKAN_TIMEOUT_MS','JIKAN_MAX_RETRIES','JIKAN_BACKOFF_BASE_MS','JIKAN_BACKOFF_MAX_MS',
  'JIKAN_CACHE_TTL_SECONDS'
);
