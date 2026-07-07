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
6. Images: `expo-image` (NOT React Native Image).

## Mobile grid pattern (IMPORTANT)
- NEVER use `FlatList numColumns` or `flexWrap` + `gap` — both cause bugs on Android.
- Use chunked rows: split items into arrays of N, render each row as a `<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>`, add invisible spacer Views for incomplete rows.
- `PosterCard` accepts a `style` prop — pass `{ marginRight: 0 }` inside grids (default marginRight: spacing.md).
- For large lists (100+ items): use FlatList with `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`.

## Mobile push notifications
- `usePushNotifications(enabled)` hook in `apps/mobile/hooks/usePushNotifications.ts`.
- Called from `(tabs)/_layout.tsx` with `enabled = !!user`.
- Expo Go: works via Expo Push API with `EXPO_ACCESS_TOKEN`.
- Dev build: requires Firebase `google-services.json` in `android/app/` + gradle plugins in both `build.gradle` files.
- Self-hosted: `PUSH_MODE=relay` sends through public server's `/api/push/relay` endpoint.

## Self-hosted backend support
- Mobile app has a "Self-hosted backend" checkbox on login/register.
- When checked: hides social login, shows URL input, stores URL in SecureStore.
- API client reads base URL from SecureStore via `getBaseUrl()` in `apps/mobile/api/client.ts`.
- Backend URL editable in Settings page.
- `PUBLIC_API_URL` in `app.json` (extra.publicApiUrl) is constant — used for push relay only.

## Admin console
- Next.js App Router under `apps/admin/app/(admin)/`.
- Auth: JWT stored in localStorage, axios interceptor injects Bearer token.
- Role-based: `useAuth()` hook, sidebar items filtered by role.
- Settings are AES-256-GCM encrypted in DB (SettingService).
- Feature flags enforced server-side (FeatureFlagService).

## Import system
- TVTime GDPR export: `seen_episode_source.csv` + `tracking-prod-records.csv` (v1) + `tracking-prod-records-v2.csv` + `user_tv_show_data.csv` + `followed_tv_show.csv`.
- v2 per-episode rows (no `type` column, has season+episode) → WATCHED_EPISODE.
- v2 summary rows (has `is_followed`/`is_for_later`, no episode) → WATCHLIST_SHOW.
- After import confirm: `rebuildShowStatuses` recalculates watched/total counts (excluding specials).
- `watch_history.runtimeMinutes` fetched from episode/movie data during apply.

## Windows development notes
- Use `node-linker=hoisted` in `.npmrc` (avoids pnpm path length issues with CMake).
- Set `JAVA_HOME=C:\Program Files\Java\jdk-18.0.2` as User environment variable.
- Prisma generate may fail with EPERM if node processes are running — kill all node first.
- After `pnpm install`, always run `pnpm --filter @tvwatch/api prisma generate` to regenerate client types.

## Testing
- Backend: Jest. Unit tests for services, e2e for controllers.
- Mobile: Jest for logic/hooks; React Native Testing Library for components.
- Import tests: `apps/api/src/import/import.spec.ts` (20 tests covering zip safety + inference).

## Key files to know
- `apps/api/prisma/schema.prisma` — full DB schema (52+ tables)
- `apps/api/src/common/prisma/prisma.module.ts` — global module (Prisma + FeatureFlags + Settings)
- `apps/api/src/notifications/notification.scheduler.ts` — episode notification logic
- `apps/api/src/import/lib/inference.ts` — TVTime CSV entity detection
- `apps/api/src/media-metadata/providers/tmdb.client.ts` — global TMDb rate limiter
- `apps/mobile/api/client.ts` — HTTP client with auth + self-hosted URL support
- `apps/mobile/api/hooks.ts` — all React Query hooks
- `apps/mobile/components/cards.tsx` — PosterCard, EpisodeCard (with swipe), grids
- `apps/mobile/components/Leaderboard.tsx` — leaderboard component
- `apps/mobile/components/CommentImage.tsx` — comment image display + full-screen viewer
- `docs/DOCUMENTATION.md` — complete technical reference (18 sections)
- `docs/To_DO.md` — project status tracker
