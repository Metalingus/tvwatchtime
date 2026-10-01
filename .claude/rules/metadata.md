---
paths:
  - "apps/api/src/media-metadata/**"
  - "apps/api/src/shows/**"
  - "apps/api/src/movies/**"
  - "apps/admin/app/(admin)/metadata-health/**"
  - "apps/admin/app/(admin)/providers/**"
---

# Metadata system (hydration, providers, identity, repairs)

- **Read `docs/METADATA_OPERATIONS.md` first** (hydration, anime classification/routing, artwork,
  locales, Metadata Health repairs). Architecture: `docs/MULTI_PROVIDER_METADATA.md`.
  Background: `DOCUMENTATION.md` §10 (metadata) and §19 (TVDB).
- Providers: `providers/tmdb.client.ts` (TMDb rate limiter), `providers/tvdb.client.ts` (TVDB rate
  limiter + JWT auth), `providers/tvdb.provider.ts` (search + hydration).
  `discovery.service.ts` merges TMDb + TVDB search with a Redis cache.
- Identity resolution: normal TMDB/TVDB matching first. WatchForge is consulted only for unresolved
  identities, and its mapping must be corroborated with provider data. A provider outage or quota
  is not conflicting evidence. See `docs/WATCHFORGE_IMPLEMENTATION_PLAN.md`.
- Repairs must preserve library data and recorded episode redirects. Running a repair job against a
  shared DB is approval gate #2.
- Bulk hydration hits rate-limited external providers. Test with fixtures/mocks, and ask before
  triggering large live hydration runs (gate #5).
- Release date semantics (airDate/airTime, timezones): `docs/RELEASE_DATES.md`.
