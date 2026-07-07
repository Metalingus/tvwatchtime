# Technical Architecture

See `docs/DOCUMENTATION.md` for the complete technical reference.

## Stack
| Layer | Technology |
|-------|-----------|
| Mobile | Expo (React Native) SDK 54, Expo Router 6 |
| Shared types | `@tvwatch/shared` (TypeScript, CJS dist) |
| Backend | NestJS 10 + Prisma 5 + PostgreSQL 16 + Redis 7 + BullMQ |
| Admin | Next.js 14 + Tailwind + Recharts + Axios |
| Storage | S3-compatible (MinIO in dev) |
| Push | Expo Push API (Expo Go) / Firebase Admin (prod) / Push Relay (self-hosted) |
| Metadata | TMDb + TVmaze |
| Moderation | OpenAI omni-moderation-latest |

## Key Architectural Decisions
1. **Mobile never calls third-party APIs** — all metadata flows through backend
2. **BullMQ for heavy work** — imports, image processing, hydration (off the request thread)
3. **DB-driven cron jobs** — schedules editable in admin without restart
4. **Encrypted settings** — secrets stored AES-256-GCM, `.env` as fallback
5. **Special seasons (S0) excluded** from all progress/count/notification calculations
6. **Global TMDb rate limiter** — serialized calls, configurable RPS, 429 backoff
7. **Title-based import matching** — no external IDs in TVTime export, so matching by normalized title + TMDb search fallback
8. **Chunked-row grids** on mobile (no flexWrap/gap — reliable across RN versions)
9. **Feature flags enforced server-side** — not just UI hiding
10. **Season/episode upsert (not replace)** — preserves user progress across refreshes
11. **Single mobile binary, dual target** — same app connects to public backend or a self-hosted instance via SecureStore URL override; `extra.apiBaseUrl` is the public default, `extra.publicApiUrl` + `extra.eas.projectId` stay constant for push relay
12. **Push relay for self-hosted** — self-hosted backends without Expo/Firebase creds route through the public instance's `POST /api/push/relay` (Redis rate-limited per token)
