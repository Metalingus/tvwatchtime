# AGENTS.md — how to work in this repo

> Router file: standing rules, commands, and approval gates live here. Deep domain knowledge lives in `docs/` — see **Deep docs** below and read the routed file BEFORE touching that area.

## Stack
- Monorepo: pnpm workspaces. Apps live in `apps/*`; shared packages live in `packages/*`.
- Mobile: `@tvwatch/mobile` — Expo, Expo Router, React Native, and TypeScript.
- API: `@tvwatch/api` — NestJS, Prisma, PostgreSQL, Redis, and BullMQ.
- Admin: `@tvwatch/admin` — Next.js, Tailwind, and Recharts.
- Shared: `@tvwatch/shared` — shared types/contracts, distributed as CJS.
- Read exact framework and dependency versions from the relevant `package.json` and lockfile. Do not rely on versions copied into documentation.

## Sources of truth and conflicts
- The user's current request defines the task and its allowed scope.
- This file and the routed domain docs define intended repository invariants.
- Package manifests and the lockfile define installed dependency versions.
- `apps/api/prisma/schema.prisma` and checked-in migrations define the intended database structure.
- Existing code defines current behavior, but may contain the bug being fixed.
- For CommsUni API behavior, read the relevant sections of [the provider guide](docs/commsuni-api-integration.md). [TVWatch implementation notes](docs/COMMSUNI_INTEGRATION.md) describe our code and remaining gaps; they do not replace the provider contract. Distinguish documented behavior, observed responses, and unverified assumptions when reporting findings. The user's rollout and product instructions still govern our work.
- If code and documentation conflict, do not silently choose one. Identify the conflict, preserve user data and compatibility, and state which interpretation the change follows.

## Non-negotiable working rules
- Inspect nearby code, tests, and routed documentation before changing behavior.
- Keep changes narrowly scoped; do not refactor unrelated code.
- Never print secrets or complete connection strings.
- Never claim that a command passed unless it completed successfully.
- The product owner runs builds and exports. Do not run application/package/image build commands or Expo exports unless the user explicitly delegates that specific build/export. Typechecks with no emit, lint, and focused tests remain allowed.
- Never publish, deploy, submit, or modify shared/production resources without explicit approval in the current conversation.
- Preserve user data during migrations, imports, metadata repairs, and account operations.

## Common commands
- Install: `pnpm install`
- Infra: `docker compose up -d` (Postgres, Redis, MinIO)
- DB client generation: `pnpm db:generate`
- Dev: `pnpm dev:api`, `pnpm dev:mobile`, `pnpm --filter @tvwatch/admin dev`
- Validate: `pnpm typecheck`, `pnpm lint`, plus the narrowest relevant test command.

### TypeScript command safety

- Never invoke `tsc` with source filenames, such as
  `tsc path/to/file.ts` or `tsc path/to/file.tsx`.
- Passing source files directly can bypass the workspace `tsconfig` behavior
  and emit `.js` files beside `.ts`/`.tsx` source files.
- Typecheck through the workspace script:
  `pnpm --filter <workspace> typecheck`.
- When invoking TypeScript directly, always use project mode:
  `tsc -p path/to/tsconfig.json --noEmit`.
- Never use bare `tsc`, `npx tsc <file>`, or `pnpm exec tsc <file>` for
  validation.
- After validation, inspect `git status --short`. Unexpected source-adjacent
  `.js`, `.js.map`, or `.d.ts` files mean validation failed and must be
  investigated.

## Database change workflow
- For schema changes, create and review the appropriate checked-in migration, then regenerate the Prisma client.
- Do not apply migrations, run `db push`, seed a shared database, or otherwise write to a shared/staging/production database without explicit approval.
- `prisma db push` applies schema diffs only; it cannot perform row backfills. Put data transformations in reviewed migration SQL or a dedicated idempotent backfill script.
- `prisma db execute` applies SQL but does not, by itself, record a migration as applied in Prisma's migration history. Use it only under the repository's documented exceptional migration procedure.
- Never use `prisma db push --accept-data-loss` as a routine schema workflow. It requires explicit approval for that exact destructive operation and verification that the target database is disposable or safely backed up.
- Before any Prisma CLI command, verify the intended target database without printing its credentials. `DATABASE_URL` is CLI-only and special characters must be URL-encoded.

## May run without approval
- Read-only inspection commands.
- Typechecks, linting, formatting checks, and focused tests relevant to changed files.

## Human approval required — ALWAYS ask first
Never perform the following without explicit user confirmation in the current conversation:
1. `docker push`, deployments, package publication, app-store submission, or any other external release.
2. Any migration, `db push`, seed, backfill, repair job, or other write against a shared, staging, or production database.
3. Destructive local database operations, including `--accept-data-loss`, resets, truncation, or irreversible cleanup.
4. Full or unusually expensive test suites when a focused test is sufficient.
5. Commands that incur material paid external-provider usage beyond the task's normal operation.

## Release requirements
- API-affecting changes require relevant local validation and a new API image before the next production release. The product owner runs the image build; report this requirement instead of running it unless explicitly delegated. Publishing/deployment still requires explicit authorization:
  ```powershell
  docker build -t ghcr.io/metalingus/tvwatch-api:latest -f apps/api/Dockerfile .
  docker push ghcr.io/metalingus/tvwatch-api:latest
  ```
  Use `--no-cache` only when cache invalidation is specifically needed.
- Web-facing changes in `apps/mobile` or a shared package used by the web app require a fresh Expo web export before the next web release. The product owner runs this export unless they explicitly delegate it:
  ```powershell
  cd apps/mobile
  npx expo export --platform web --output-dir ../app-web
  ```
- A local build/export is not a publication. Report build, export, push, and deployment results separately.

## Conventions
- Search discipline: NEVER run grep/rg from the repo root unscoped. Search `apps/*/src` or
  `packages/*/src` explicitly; never traverse `node_modules`, `dist`, `build`, `.expo`, `coverage`.
  Use `rtk grep` (or `rg`, which respects .gitignore) — never `grep -r`. Never use `rtk pnpm` because it invokes tsc without --noEmit, emitting .js files.
- The displayed product name is **TV Watch Time**. Use `common:appName` for UI labels; do not abbreviate it to TVWatch or TVWatchTime.
- Always import shared types from `@tvwatch/shared` — do not duplicate DTOs across apps.
- The Prisma schema (`apps/api/prisma/schema.prisma`) is the source of truth for the data model. Regenerate after edits: `pnpm db:generate`.
- Mobile NEVER calls third-party media APIs directly. All media data flows through the backend, which normalizes + caches external IDs.
- Use snake_case only in DB column names via Prisma `@map`. In code/TS use camelCase.
- Prettier config is at repo root (`.prettierrc.json`). Single quotes, trailing comma all, 100 width.
- Env vars: read via NestJS `ConfigService`. Never hardcode secrets.
- Special seasons (S0, `isSpecial = true`) are excluded from ALL counts, progress, and watch-next queries.
- Aired episodes only: unaired episodes (`airDate > now`) are excluded from progress bars and watch-next counts.
- The app reads `POSTGRES_*` and `REDIS_*` env vars directly (passwords with special chars are fine). `DATABASE_URL` is only for the Prisma CLI — URL-encode special chars there.

## Deep docs — read BEFORE working in these areas
Load only the doc(s) for the area your task touches — do not read all docs up front.

| Task area | Read first | Also see |
|---|---|---|
| Shell commands (token saving) | `RTK.md` — route all shell commands through `rtk` | — |
| Metadata hydration, anime classification/routing, artwork, locales, Metadata Health repairs | `docs/METADATA_OPERATIONS.md` | `docs/MULTI_PROVIDER_METADATA.md`; `docs/DOCUMENTATION.md` §10, §19 |
| Import system (anything under `apps/api/src/import/**`) | `docs/IMPORT_PIPELINE.md` (authoritative) | `docs/DOCUMENTATION.md` §11 — `IMPORT_STRATEGY.md` / `IMPORT_SYSTEM.md` are partially stale |
| Comments, external reviews, spoilers, episode voting, account deletion | `docs/SOCIAL_SYSTEMS.md` | `docs/DATA_MODEL.md`; `docs/DOCUMENTATION.md` §13, §21 |
| CommsUni API, shared comments/engagement, IDs, caching, or delivery | [Provider guide](docs/commsuni-api-integration.md), relevant sections; [TVWatch implementation notes](docs/COMMSUNI_INTEGRATION.md) | [Review and validation record](docs/COMMSUNI_REVIEW.md); `docs/SOCIAL_SYSTEMS.md` |
| Push registration, scheduling, timezone spread | `docs/PUSH_DELIVERY.md` | `docs/NOTIFICATIONS.md`; `docs/DOCUMENTATION.md` §12, §23 |
| Environment variables / feature degradation | `docs/ENVIRONMENT.md` | — |
| Full technical reference | `docs/DOCUMENTATION.md` | — |
| Project status / remaining work | `docs/To_DO.md` | `docs/ROADMAP.md` |

## Adding a backend module
1. Add models to `schema.prisma`, create/review the migration files, and run `pnpm db:generate`. Applying the migration requires approval under the database rules above.
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

## Localization and theme requirements
- All user-facing text must use the existing translation/i18n system. Do not introduce hardcoded UI strings when a translation key should be used.
- When adding or changing user-facing copy, add or update the key in every supported locale. Check for missing, stale, or fallback-only translations before finishing.
- Reuse existing translation keys when their meaning matches; keep key names consistent and descriptive.
- All colors, spacing, typography, radii, shadows, and other visual values must come from the shared theme/design tokens whenever a token exists. Do not add unexplained hardcoded visual values.
- Components must work with the supported light, dark, and system-selected themes. Verify contrast and state styling in both light and dark modes.

## Mobile grid pattern (IMPORTANT)
- NEVER use `FlatList numColumns` or `flexWrap` + `gap` — both cause bugs on Android.
- Use chunked rows: split items into arrays of N, render each row as a `<View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>`, add invisible spacer Views for incomplete rows.
- `PosterCard` accepts a `style` prop — pass `{ marginRight: 0 }` inside grids.
- For large lists (100+ items): use FlatList with `initialNumToRender`, `maxToRenderPerBatch`, `windowSize`.

## iOS native modal safety (IMPORTANT)
- NEVER call the global `showDialog` / `showConfirm` / `showError` helpers, present a sheet, or open a second React Native `Modal` while another native `Modal` is visible. UIKit can reject or wedge the overlapping presentation and leave the iOS app unresponsive even when the same flow works on Android and web.
- Render confirmations, errors, loading states, and follow-up actions inline inside the currently visible modal whenever possible. Toasts are acceptable for non-blocking success/error feedback.
- If a second native presentation is unavoidable, dismiss the current modal first and wait for its `onDismiss` callback before presenting the next one; do not rely on two state updates in the same render tick.
- For every modal action flow, verify open → action → confirm/cancel → back/close on iOS. Passing Android/web validation is not evidence that native iOS modal presentation is safe.

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
- Auth: JWT stored in localStorage, axios interceptor injects Bearer token. Login has a "Stay connected" checkbox → `/auth/login` with `rememberMe: true` → 30d access token (`JWT_REMEMBER_TTL`, default `30d`; normal logins keep `JWT_ACCESS_TTL` 15m).
- `API_URL` env var (runtime, NOT `NEXT_PUBLIC_*`) — injected into HTML via `layout.tsx`.
- Role-based: `useAuth()` hook, sidebar items filtered by role.
- Settings are AES-256-GCM encrypted in DB (SettingService).
- Feature flags enforced server-side (FeatureFlagService).
- Moderation page at `/moderation` for MODERATOR+ roles.
- Scheduled Jobs (`/cron`): DB-driven via CronManagerService (node-cron). Each job has an optional **IANA timezone** (stored on `CronJob.timezone`, null = server default) applied at scheduling; schedules are edited through a friendly frequency picker (`apps/admin/components/SchedulePicker.tsx`, custom cron stays available). Every run persists an outcome summary in `CronJobRun.result` (rendered as the Report column in history). Jobs execute ONLY through CronManager — never add `@Cron` decorators for DB-managed jobs (the NotificationScheduler methods are decorator-free for exactly this reason).
- Auto Hydrations (`/scheduled-hydrations`): each row is its own dynamic node-cron job with its own schedule + timezone (`CronManagerService.syncHydrationSchedules` at boot + hourly resync). Rows do NOT fire in a shared hourly batch. Run reports land on the Jobs page (`HydrationJob` tracking).
- TMDB Changes sync: `POST /admin/tmdb-changes/run?start=YYYY-MM-DD` runs a one-off custom range WITHOUT moving the Redis cursor (`TMDB_CHANGES_LAST_RUN`); the daily cron keeps its progression.

## Graceful degradation (CapabilityService)
- `CapabilityService` detects what features are available from env config.
- Exposed via `GET /feature-flags` endpoint (public).
- Missing `OPENAI_API_KEY` → moderation skipped, images still stored.
- Missing S3/MinIO config → comment images return 503, user images use local files.
- Missing `TMDB_API_KEY` / `TVDB_API_KEY` → search falls back to DB.
- Missing OAuth credentials → social login buttons hidden in mobile app.

## Windows development notes
- Preserve the repository's existing pnpm linker and shortened external `virtual-store-dir` configuration. It is intentional for controlling native-build path lengths; do not switch linker modes as a generic fix for one dependency error.
- Read the required Java version from the Android/Expo toolchain configuration before changing `JAVA_HOME`; do not rely on a hardcoded JDK version in this file.
- Prisma generate may fail with `EPERM` while Node processes hold generated files open. Stop only the relevant processes, then retry.
- After `pnpm install`, run `pnpm --filter @tvwatch/api prisma generate` to regenerate client types.

## Final verification and response
Before considering a task complete, review the final diff and check every applicable item:
- API changes: relevant API validation completed; state whether an image build is release-required, locally completed, or not run. Treat publication/deployment as separate approved actions.
- Web changes: state whether a fresh Expo web export is release-required, locally completed, or not run.
- Localization: all changed user-facing strings use translation keys and every supported locale includes the required translations.
- Theme: UI changes use shared theme/design tokens and support light, dark, and system themes.
- Quality: relevant typechecks, linting, and focused tests ran, or skipped checks are clearly identified with the reason.
- Data safety: migration/backfill implications were reviewed whenever data models or repair/import behavior changed.

In the final response, provide a concise checklist of applicable areas, completed commands/checks, failures, skipped validation, and remaining release steps or risks. Never imply that an unrun command completed.

## Testing
- Prefer the narrowest relevant test command and run focused tests without asking first.
- Ask before running the full repository suite or an unusually expensive suite when focused coverage is sufficient.
- Backend: Jest. Unit tests for services, e2e for controllers (`pnpm --filter @tvwatch/api test`). Strategy: `docs/TESTING.md`.
- Mobile: Jest for logic/hooks; React Native Testing Library for components.
- Import tests: `apps/api/src/import/import.spec.ts` + `lib/{ratings,emotions,comments}.spec.ts` + `lib/trakt/*.spec.ts` + `lib/tvtime-json/*.spec.ts` + `import-pipeline{,-trakt,-tvtime-json,-tvtime-out}.spec.ts` (350+ tests covering zip safety, inference, mappings, ownership/deduplication, format detection, external-ID matching, and fixture pipelines).

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
- `apps/api/src/data-deletion/data-deletion.service.ts` — email-based account deletion (anonymize-and-delete via `users/lib/deleted-user.ts`)
- `apps/mobile/api/client.ts` — HTTP client with auth + self-hosted URL + `SITE_URL`
- `apps/mobile/api/hooks.ts` — all React Query hooks (50+); `useEpisodeVotes` = per-section optimistic vote mutations
- `apps/mobile/components/cards.tsx` — PosterCard, EpisodeCard, grids
- `apps/mobile/components/ListCard.tsx` — custom list card with poster background
- `apps/mobile/components/primitives.tsx` — PosterImage (uses expo-image), T, Button, Card, etc.
- `apps/mobile/components/voting/` — icon-based episode voting (VotingSection, SelectableIconTile, StarRatingControl, ReactionGrid, FavoriteCharacterVote, `meta.ts`)
- `packages/shared/src/vote-math.ts` — largest-remainder `computePercentages` + `applyVoteChange` (optimistic recompute), shared by API tests + mobile
- `apps/mobile/app/_layout.tsx` — Gate component (auth routing, mustChangePassword)
- `docs/DOCUMENTATION.md` — complete technical reference
- `docs/ENVIRONMENT.md` — full env variable reference + feature degrade summary
- `docs/To_DO.md` — project status tracker
- `production-docs/` — deployment, scaling, and build guides
