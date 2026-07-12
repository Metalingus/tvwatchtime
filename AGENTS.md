# AGENTS.md — how to work in this repo

## Stack
- Monorepo: pnpm workspaces. Apps in `apps/*`, shared packages in `packages/*`.
- Mobile: `@tvwatch/mobile` (Expo SDK 54 + Expo Router 6). TypeScript + React Native.
- API: `@tvwatch/api` (NestJS 10 + Prisma 5 + PostgreSQL 16 + Redis 7 + BullMQ).
- Admin: `@tvwatch/admin` (Next.js 14 + Tailwind + Recharts).
- Shared: `@tvwatch/shared` (types/contracts used by both apps, CJS dist).

## Common commands
- Install: `pnpm install`
- Infra: `docker compose up -d` (Postgres, Redis, MinIO)
- DB: `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`
- Dev: `pnpm dev:api`, `pnpm dev:mobile`, `pnpm --filter @tvwatch/admin dev`
- Validate: `pnpm typecheck`, `pnpm lint`, `pnpm test`
- After schema changes: `$env:DATABASE_URL="..."; pnpm --filter @tvwatch/api prisma db push --accept-data-loss; pnpm --filter @tvwatch/api prisma generate`

## Conventions
- Always import shared types from `@tvwatch/shared` — do not duplicate DTOs across apps.
- The Prisma schema (`apps/api/prisma/schema.prisma`) is the source of truth for the data model. Regenerate after edits: `pnpm db:generate`.
- Mobile NEVER calls third-party media APIs directly. All media data flows through the backend, which normalizes + caches external IDs.
- Use snake_case only in DB column names via Prisma `@map`. In code/TS use camelCase.
- Prettier config is at repo root (`.prettierrc.json`). Single quotes, trailing comma all, 100 width.
- Env vars: read via NestJS `ConfigService`. Never hardcode secrets.
- Special seasons (S0, `isSpecial = true`) are excluded from ALL counts, progress, and watch-next queries.
- Aired episodes only: unaired episodes (`airDate > now`) are excluded from progress bars and watch-next counts.
- The app reads `POSTGRES_*` and `REDIS_*` env vars directly (passwords with special chars are fine). `DATABASE_URL` is only for the Prisma CLI — URL-encode special chars there.

## Adding a backend module
1. Add models to `schema.prisma` + run `pnpm db:generate` and a migration.
2. Create `module`/`service`/`controller`/`dto` under `apps/api/src/<module>`.
3. Use `@CurrentUser()` decorator + `JwtAuthGuard` for authenticated routes.
4. Export the module from `AppModule`.

## Adding a mobile screen
1. Add route under `apps/mobile/app/` (Expo Router file-based).
2. Fetch via `apps/mobile/api/client.ts` (`api.get`/`api.post`) which injects the JWT.
3. Use the shared theme (`apps/mobile/theme/theme.ts`) + component system in `apps/mobile/components`.
4. Respect dark theme + safe areas.
5. Icons: `@expo/vector-icons` (Ionicons).
6. Images: `expo-image` `Image` (NOT React Native Image, NOT `PosterImage` for search results — use `expo-image` directly with `contentFit="cover"`).

## Mobile grid pattern (IMPORTANT)
- NEVER use `FlatList numColumns` or `flexWrap` + `gap` — both cause bugs on Android.
- Use chunked rows: split items into arrays of N, render each row as a `<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>`, add invisible spacer Views for incomplete rows.
- `PosterCard` accepts a `style` prop — pass `{ marginRight: 0 }` inside grids.
- For large lists (100+ items): use FlatList with `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`.

## Mobile push notifications
- `usePushNotifications(enabled)` hook in `apps/mobile/hooks/usePushNotifications.ts`.
- Called from `(tabs)/_layout.tsx` with `enabled = !!user`.
- Expo Go: works via Expo Push API with `EXPO_ACCESS_TOKEN`.
- Dev build: requires Firebase `google-services.json` in `android/app/` + gradle plugins in both `build.gradle` files.
- Self-hosted: `PUSH_MODE=relay` sends through public server's `/api/push/relay` endpoint.
- Episode notifications spread across afternoon (noon→3pm→4pm...).

## Self-hosted backend support
- Mobile app has a "Self-hosted backend" checkbox on login/register.
- When checked: hides social login, shows URL input, stores URL in SecureStore.
- API client reads base URL from SecureStore via `getBaseUrl()` in `apps/mobile/api/client.ts`.
- Backend URL editable in Settings page.
- `PUBLIC_API_URL` in `app.json` (extra.publicApiUrl) is constant — used for push relay only.
- `SITE_URL` in `.env` is used for data deletion + password reset email links.

## OAuth flow
- Mobile app opens browser via `WebBrowser.openBrowserAsync()` to Google/Facebook OAuth.
- Redirect URI: `{API_BASE}/auth/oauth-callback` (backend endpoint).
- Backend receives code → 302 redirect to `tvwatchtime://expo-auth-session?code=xxx`.
- Mobile `expo-auth-session.tsx` route captures code via `useLocalSearchParams()`.
- No Expo auth proxy — uses app's own domain.

## Admin console
- Next.js App Router under `apps/admin/app/(admin)/`.
- Auth: JWT stored in localStorage, axios interceptor injects Bearer token.
- `API_URL` env var (runtime, NOT `NEXT_PUBLIC_*`) — injected into HTML via `layout.tsx`.
- Role-based: `useAuth()` hook, sidebar items filtered by role.
- Settings are AES-256-GCM encrypted in DB (SettingService).
- Feature flags enforced server-side (FeatureFlagService).
- Moderation page at `/moderation` for MODERATOR+ roles.

## Import system
- TVTime GDPR export: `seen_episode_source.csv` + `tracking-prod-records.csv` (v1+v2) + `user_tv_show_data.csv` + `followed_tv_show.csv` + `lists-prod-lists.csv`.
- v2 per-episode rows → WATCHED_EPISODE. v2 summary rows → WATCHLIST_SHOW.
- Lists: `lists-prod-lists.csv` rows with `type=list` (skipping `collection`/`count` metadata) → `CustomList` with `source=TVTIME`, identity by `(userId, source, sourceKey)`. Series items resolved via `{tv_show_id→name}` map + media matcher; movie items (uuid) → unresolved warnings. Visibility defaults PRIVATE. Re-import updates metadata + adds missing items; manual lists untouched. See `lib/list-objects.ts` + `lib/lists.ts`.
- Ratings: episode/movie vote files (`ratings-*-votes`) use the verified `stars_wording_scalev2` set (id→star via final `vote_key` segment; UUID movie keys split on last `-` only). `tv_show_rate.csv` → direct 1–5 show rating (out-of-range skipped). Unknown ids/sets skipped with warnings, never guessed. Conflict policy: never overwrite manual/local ratings; idempotent via `source=TVTIME`+`sourceKey`. See `lib/ratings.ts`.
- Emotions: `emotions-*-votes` use the verified `12_all` set (id 36 → enum `UNDERSTANDING`). Legacy `episode_emotion.csv` ids (1,3,6,7,…) are unsupported. Multiple emotions per target retained; additive apply (never removes existing); `tv_show_user_emotion_count.csv` is an aggregate, skipped. See `lib/emotions.ts`.
- Comments: ONLY owner-authored top-level media comments imported (`comments-prod-comments.csv` + legacy `episode_comment.csv`). Owner resolved from `user.csv`/`user_personal_data.csv`. Replies, embedded `replies` blobs, likes, reports, read markers, translations, profile-wall comments all skipped+counted. Created directly via Prisma (no `comment.created` event → no badges, no notifications); historical timestamps preserved; `source=TVTIME`+`sourceKey` for idempotent re-import. Comment text is NEVER logged. See `lib/comments.ts`.
- CSV compatibility: header-based mapping only (never positional); `<nil>`/empty → null; reordered/extra columns tolerated; unknown files skipped.
- Batched apply: `createMany` in 5000-row chunks, **one raised-timeout `$transaction` per section** (episodes/movies/watchlist/favorites/lists), not one giant transaction — each section marks its items `APPLIED` so BullMQ/manual retries are idempotent. Apply timeouts via `IMPORT_TX_TIMEOUT_MS` (default 60s).
- `<nil>` values are normalized to null (not 0).
- After import confirm: `rebuildShowStatuses` recalculates watched/total counts.
- Configurable worker concurrency via `IMPORT_WORKER_CONCURRENCY` env.

## Graceful degradation (CapabilityService)
- `CapabilityService` detects what features are available from env config.
- Exposed via `GET /feature-flags` endpoint (public).
- Missing `OPENAI_API_KEY` → moderation skipped, images still stored.
- Missing S3/MinIO config → comment images return 503, user images use local files.
- Missing `TMDB_API_KEY` / `TVDB_API_KEY` → search falls back to DB.
- Missing OAuth credentials → social login buttons hidden in mobile app.

## Windows development notes
- Use `node-linker=hoisted` in `.npmrc` (avoids pnpm path length issues with CMake).
- Set `JAVA_HOME=C:\Program Files\Java\jdk-18.0.2` as User environment variable.
- Prisma generate may fail with EPERM if node processes are running — kill all node first.
- After `pnpm install`, always run `pnpm --filter @tvwatch/api prisma generate` to regenerate client types.

## Testing
- Backend: Jest. Unit tests for services, e2e for controllers.
- Mobile: Jest for logic/hooks; React Native Testing Library for components.
- Import tests: `apps/api/src/import/import.spec.ts` + `lib/{ratings,emotions,comments}.spec.ts` + `import-pipeline.spec.ts` (120 tests covering zip safety, inference, ratings/emotions mappings, comment filtering/ownership/dedup, and the full fixture pipeline).

## Key files to know
- `apps/api/prisma/schema.prisma` — full DB schema (60+ tables)
- `apps/api/src/common/prisma/prisma.module.ts` — global module (Prisma + FeatureFlags + Settings + Capability + Email)
- `apps/api/src/common/capability.service.ts` — graceful degradation detection
- `apps/api/src/common/email.service.ts` — SMTP via nodemailer
- `apps/api/src/notifications/notification.scheduler.ts` — episode + watchlist notifications, export cleanup
- `apps/api/src/import/import.service.ts` — batched import apply (createMany)
- `apps/api/src/media-metadata/providers/tmdb.client.ts` — TMDb rate limiter
- `apps/api/src/media-metadata/providers/tvdb.client.ts` — TVDB rate limiter + JWT auth
- `apps/api/src/media-metadata/providers/tvdb.provider.ts` — TVDB search + hydration
- `apps/api/src/media-metadata/discovery.service.ts` — merged TMDb + TVDB search with Redis cache
- `apps/api/src/social/moderation.service.ts` — block/report/admin moderation
- `apps/api/src/users/export.service.ts` — data export (JSON, 24h expiry)
- `apps/api/src/data-deletion/data-deletion.service.ts` — email-based account deletion
- `apps/mobile/api/client.ts` — HTTP client with auth + self-hosted URL + `SITE_URL`
- `apps/mobile/api/hooks.ts` — all React Query hooks (50+)
- `apps/mobile/components/cards.tsx` — PosterCard, EpisodeCard, grids
- `apps/mobile/components/ListCard.tsx` — custom list card with poster background
- `apps/mobile/components/primitives.tsx` — PosterImage (uses expo-image), T, Button, Card, etc.
- `apps/mobile/app/_layout.tsx` — Gate component (auth routing, mustChangePassword)
- `docs/DOCUMENTATION.md` — complete technical reference
- `docs/ENVIRONMENT.md` — full env variable reference + feature degrade summary
- `docs/To_DO.md` — project status tracker
- `production-docs/` — deployment, scaling, and build guides
