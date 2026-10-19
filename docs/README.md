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
| `SELF_HOSTING.md` | Self-hosting with the pre-built Docker images |
| `ENVIRONMENT.md` | Every env var + feature degradation |
| `DATA_MODEL.md` | Data model overview (`schema.prisma` is the source of truth; counts here may lag) |
| `WATCHFORGE_IMPLEMENTATION_PLAN.md`, `WATCHFORGE_TESTING.md` | WatchForge identity scope and validation |

## Broad reference (older; prefer the deep docs above)
`DOCUMENTATION.md` (full technical reference with §-numbered TOC), `API_CONTRACT.md`, `TESTING.md`,
`SECURITY.md`, `NOTIFICATIONS.md`, `PRD.md`.

## Status
`To_DO.md` (status tracker), `ROADMAP.md`.

## Historical records (context only, not current instructions)
- `WATCHFORGE_DATABASE_FINDINGS.md` (2026-09-19 design), `WATCHFORGE_ASSESSMENT.md` (superseded).
- Stale stubs: `IMPORT_STRATEGY.md`, `IMPORT_SYSTEM.md` (use `IMPORT_PIPELINE.md`),
  `ARCHITECTURE.md`, `API_COMPARISON.md`.
