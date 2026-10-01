# Docs map

Pick one doc using this map instead of opening several. For large docs, grep `^#{1,3} ` headings
and read only the section you need. When a deep doc and `DOCUMENTATION.md` disagree, the deep doc
wins; when any doc disagrees with code or `schema.prisma`, report the conflict.

## Authoritative deep references (keep current when behavior changes)
| Doc | Covers |
|---|---|
| `IMPORT_PIPELINE.md` | Import formats, matching, apply, tests |
| `METADATA_OPERATIONS.md` | Hydration, anime routing, artwork, locales, Metadata Health repairs |
| `MULTI_PROVIDER_METADATA.md` | Provider architecture (TMDb, TVDB, …) |
| `SOCIAL_SYSTEMS.md` | Comments, external reviews, spoilers, voting, account deletion |
| `PUSH_DELIVERY.md` | Push registration, scheduling, timezone spread |
| `RELEASE_DATES.md` | airDate/airTime semantics, notification frequency |
| `INBOUND_INTEGRATIONS.md` | SIMKL, Stremio, Jellyfin, Plex, Emby |
| `ENVIRONMENT.md` | Every env var + feature degradation |
| `DATA_MODEL.md` | Data model overview (`schema.prisma` is the source of truth; counts here may lag) |
| `COMMSUNI_INTEGRATION.md` | Our CommsUni implementation and open gaps |
| `COMMSUNI_BACKFILL.md` | CommsUni write rollout + historical backfill runbook |
| `WATCHFORGE_IMPLEMENTATION_PLAN.md`, `WATCHFORGE_TESTING.md` | WatchForge identity scope and validation |

## External contract (do not edit to match our code)
- `commsuni-api-integrationv2.md`: current CommsUni provider guide (~2.5k lines).
- `commsuni-api-integration.md` / `commsuni-api-backfill.md`: older provider copies, gitignored and
  local-only. `partner-api-*.md` are alias stubs.

## Broad reference (older; prefer the deep docs above)
`DOCUMENTATION.md` (full technical reference with §-numbered TOC), `API_CONTRACT.md`, `TESTING.md`,
`SECURITY.md`, `NOTIFICATIONS.md`, `PRD.md`.

## Status
`To_DO.md` (status tracker), `ROADMAP.md`.

## Historical records (context only, not current instructions)
- `COMMSUNI_REVIEW.md`: validation log. Its recorded product decisions still govern rollout.
- `COMMSUNI_AUDIT_2026-09-13.md`, `COMMSUNI_CONTRACT_REVIEW_2026-09-17.md`: dated reviews.
- `WATCHFORGE_DATABASE_FINDINGS.md` (2026-09-19 design), `WATCHFORGE_ASSESSMENT.md` (superseded).
- Stale stubs: `IMPORT_STRATEGY.md`, `IMPORT_SYSTEM.md` (use `IMPORT_PIPELINE.md`),
  `ARCHITECTURE.md`, `API_COMPARISON.md`.
