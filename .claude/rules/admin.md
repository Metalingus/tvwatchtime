---
paths:
  - "apps/admin/**"
  - "apps/api/src/admin/**"
---

# Admin console + admin API

- Next.js App Router under `apps/admin/app/(admin)/`. English-only: no i18n layer exists here.
- Auth: JWT in localStorage; an axios interceptor (`lib/api.ts`) injects the Bearer token. The
  "Stay connected" login checkbox sends `rememberMe: true` → 30d token (`JWT_REMEMBER_TTL`,
  default `30d`). Normal logins keep `JWT_ACCESS_TTL` (15m).
- `API_URL` is a runtime env var (NOT `NEXT_PUBLIC_*`), injected into HTML via `layout.tsx`.
- Role-based access: `useAuth()` hook; sidebar items are filtered by role. Moderation (`/moderation`)
  is MODERATOR+. API side: `roles.guard.ts` / `roles.decorator.ts`.
- Settings are AES-256-GCM encrypted in the DB (SettingService). Feature flags are enforced
  server-side (FeatureFlagService).

## Scheduled Jobs (`/cron`)
- DB-driven through `CronManagerService` (node-cron). Each job has an optional IANA timezone
  (`CronJob.timezone`; null = server default) applied at scheduling.
- The schedule UI is `components/SchedulePicker.tsx` (friendly picker; custom cron still allowed).
- Every run stores an outcome summary in `CronJobRun.result`, shown as the Report column.
- Jobs execute ONLY through CronManager. Never add `@Cron` decorators for DB-managed jobs.

## Auto Hydrations (`/scheduled-hydrations`)
- Each row is its own dynamic node-cron job with its own schedule and timezone
  (`CronManagerService.syncHydrationSchedules` at boot, plus an hourly resync). Rows never fire in
  a shared hourly batch. Run reports land on the Jobs page (`HydrationJob`).

## TMDB Changes sync
`POST /admin/tmdb-changes/run?start=YYYY-MM-DD` runs a one-off custom range WITHOUT moving the Redis
cursor (`TMDB_CHANGES_LAST_RUN`); the daily cron keeps its own progression.
