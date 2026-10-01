---
paths:
  - "apps/api/**"
---

# API rules (`@tvwatch/api`)

## Adding a backend module
1. Models: `schema.prisma` → migration → `pnpm db:generate` (see the `database` rule; applying
   needs approval).
2. Create `module` / `service` / `controller` / `dto` under `apps/api/src/<module>`.
3. Authenticated routes: `@CurrentUser()` + `JwtAuthGuard`.
4. Register the module in `AppModule` (`src/app.module.ts`).

## Graceful degradation (`src/common/capability.service.ts`)
Capabilities are detected from env config and exposed at public `GET /feature-flags`.
- No `OPENAI_API_KEY` → moderation skipped, images still stored.
- No S3/MinIO → comment images return 503; user images use local files.
- No `TMDB_API_KEY` / `TVDB_API_KEY` → search falls back to DB.
- No OAuth credentials → social login buttons hidden in mobile.
New optional integrations must degrade the same way. See `docs/ENVIRONMENT.md`.

## Scheduled jobs
Jobs run ONLY through `CronManagerService` (DB-driven). Never add `@Cron` decorators for
DB-managed jobs; `NotificationScheduler` methods are decorator-free on purpose. See the `admin` rule.

## Key files
- `src/common/prisma/prisma.module.ts`: global module (Prisma, FeatureFlags, Settings, Capability, Email)
- `src/common/email.service.ts`: SMTP via nodemailer
- `src/users/export.service.ts`: data export (JSON, 24h expiry)
- `src/data-deletion/data-deletion.service.ts`: email-based deletion (anonymize-and-delete via
  `src/users/lib/deleted-user.ts`)

## Testing and release
- Jest (`jest.config.js`, roots `src/`): `*.spec.ts` beside sources, Prisma mocked. Focused:
  `pnpm --filter @tvwatch/api test -- <path-or-pattern>`. Fixtures: `apps/api/test/fixtures`.
  Strategy: `docs/TESTING.md`. The `test:e2e` script has no config/suite yet.
- `*.database.spec.ts` run against a real DB only when `WATCHFORGE_TEST_DATABASE_URL` is set, and
  skip otherwise. Point it only at a disposable database (approval gate #3).
- Any API-affecting change requires a new API image before the next production release
  (product owner builds; report it).
