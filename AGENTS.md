# AGENTS.md — TV Watch Time

Core rules for every task. Claude Code loads this through `CLAUDE.md`. Area-specific rules live in
`.claude/rules/*.md` (Claude Code loads them automatically when you touch matching files; other
agents should read the matching file before editing that area). Deep domain knowledge lives in
`docs/`; see **Routing** below and `docs/README.md`.

## Stack
pnpm workspaces monorepo. Read exact versions from `package.json` and `pnpm-lock.yaml`, not from docs.

| Path | Package | Tech |
|---|---|---|
| `apps/mobile` | `@tvwatch/mobile` | Expo + Expo Router, React Native, TS. Also shipped as a web export |
| `apps/api` | `@tvwatch/api` | NestJS, Prisma + PostgreSQL, Redis, BullMQ |
| `apps/admin` | `@tvwatch/admin` | Next.js App Router, Tailwind, Recharts (English-only, no i18n) |
| `packages/shared` | `@tvwatch/shared` | Shared types/contracts, built as CJS |

`apps/app-web/` is generated Expo web export output. Never edit it by hand.

## Sources of truth
- The user's current request defines the task and its allowed scope.
- This file, `.claude/rules/`, and the routed docs define intended invariants.
- `apps/api/prisma/schema.prisma` + checked-in migrations define the data model.
- Existing code defines current behavior, but it may contain the bug being fixed.
- If code and docs conflict, do not silently pick one. Name the conflict, preserve user data and
  compatibility, and state which interpretation you followed.

## Working rules
- Inspect nearby code, tests, and the routed doc before changing behavior.
- Keep changes narrowly scoped; no unrelated refactors.
- Never print secrets, `.env` contents, or complete connection strings.
- Never claim a command passed unless it completed successfully in this session.
- Preserve user data in migrations, imports, metadata repairs, and account operations.
- **Builds/exports belong to the product owner.** Do not run app/package/image builds or Expo
  exports unless the user explicitly delegates that specific build. Typechecks (no emit), lint,
  and focused tests are always allowed.

## Commands
| Purpose | Command |
|---|---|
| Install | `pnpm install`, then `pnpm db:generate` |
| Local infra | `docker compose up -d` (Postgres, Redis, MinIO) |
| Dev | `pnpm dev:api`, `pnpm dev:mobile`, `pnpm dev:admin` |
| Typecheck one workspace | `pnpm --filter <pkg> typecheck` (api also has `typecheck:source`) |
| Lint one workspace | `pnpm --filter <pkg> lint` |
| Focused API test | `pnpm --filter @tvwatch/api test -- <path-or-pattern>` |
| Focused mobile test | `pnpm --filter @tvwatch/mobile test -- <path-or-pattern>` |
| Locale file check | `pnpm --filter @tvwatch/mobile check:locales` |
| Prisma client | `pnpm db:generate` |

Windows: keep the `.npmrc` pnpm settings (`node-linker=isolated`, short `virtual-store-dir`). They
exist to control native-build path lengths; don't switch linker modes to fix one dependency error.
Read the required JDK from the Android/Expo toolchain config before changing `JAVA_HOME`.

Root `pnpm test` / `pnpm typecheck` / `pnpm lint` fan out to every workspace. Prefer the filtered
form; ask before running the full test suite when a focused test is sufficient.

### TypeScript safety (emitted `.js` files have happened before)
- Never pass source files to `tsc` (`tsc foo.ts`, `npx tsc foo.tsx`, `pnpm exec tsc foo.ts`).
- Typecheck through the workspace script, or `tsc -p <tsconfig.json> --noEmit`. Never bare `tsc`.
- Never `rtk pnpm` or `rtk tsc`; they invoke `tsc` without `--noEmit`.
- After validation, run `git status --short`. Unexpected `.js`, `.js.map`, or `.d.ts` files next to
  sources mean validation failed and must be investigated and removed.

## Approval gates: ALWAYS ask first
1. `docker push`, deployments, package publication, app-store submission, any external release.
2. Any migration, `db push`, seed, backfill, repair job, or other write to a shared, staging, or
   production database.
3. Destructive local DB operations: `--accept-data-loss`, resets, truncation, volume deletion.
4. Full or unusually expensive test suites when a focused test suffices.
5. Commands that incur material paid external-provider usage beyond normal task operation.

May run without asking: read-only inspection, typechecks, lint, format checks, focused tests.

## Database
- Schema change: edit `schema.prisma` → create and review a checked-in migration →
  `pnpm db:generate`. Applying the migration is gate #2.
- `prisma db push` cannot backfill rows. Put data transforms in reviewed migration SQL or an
  idempotent backfill script.
- `prisma db execute` does not record migration history. Use it only under the documented
  exceptional migration procedure.
- Before any Prisma CLI command, verify the target database without printing credentials.
- App code reads `POSTGRES_*` / `REDIS_*` directly. `DATABASE_URL` is for the Prisma CLI only and
  must be URL-encoded.
- DB columns are snake_case via Prisma `@map`; TypeScript stays camelCase.

## Domain invariants
- Special seasons (S0, `isSpecial = true`) are excluded from ALL counts, progress, and watch-next.
- Unaired episodes (`airDate > now`) are excluded from progress bars and watch-next counts.
- Mobile never calls third-party media APIs. All media data flows through the API, which
  normalizes and caches external IDs.
- Import shared types from `@tvwatch/shared`; never duplicate DTOs across apps.
- Display name is **TV Watch Time** (`common:appName`); never "TVWatch" or "TVWatchTime" in UI.
- Env vars are read through NestJS `ConfigService`. Never hardcode secrets.
- Prettier (root `.prettierrc.json`): single quotes, trailing commas, width 100.

## Mobile UI requirements (apps/mobile)
- All user-facing text uses i18n keys. Update every locale directory in `apps/mobile/locales/`;
  reuse existing keys when the meaning matches.
- All colors/spacing/typography/radii/shadows come from `apps/mobile/theme/theme.ts` tokens.
- UI must work in light, dark, and system themes.

## Routing: read before working in an area
Big docs: `Grep` for `^#{1,3} ` in the doc first, then `Read` only the relevant section by offset.

| Area | Read first | Also |
|---|---|---|
| Metadata hydration, anime routing, artwork, locales, Metadata Health, identity repair | `docs/METADATA_OPERATIONS.md` | `docs/MULTI_PROVIDER_METADATA.md`; `DOCUMENTATION.md` §10, §19 |
| Import system (`apps/api/src/import/**`) | `docs/IMPORT_PIPELINE.md` (authoritative) | `DOCUMENTATION.md` §11 |
| Comments, external reviews, spoilers, episode voting, account deletion | `docs/SOCIAL_SYSTEMS.md` | `docs/DATA_MODEL.md`; §13, §21 |
| CommsUni (shared comments/engagement, IDs, caching, delivery) | Provider contract: `docs/commsuni-api-integrationv2.md` (relevant sections only) | `docs/COMMSUNI_INTEGRATION.md`, `docs/COMMSUNI_REVIEW.md`, `docs/COMMSUNI_BACKFILL.md` |
| SIMKL/Stremio/Jellyfin/Plex/Emby integrations | `docs/INBOUND_INTEGRATIONS.md` | — |
| WatchForge identity matching | `docs/WATCHFORGE_IMPLEMENTATION_PLAN.md` | `docs/WATCHFORGE_TESTING.md`, `docs/WATCHFORGE_DATABASE_FINDINGS.md` |
| Push registration, scheduling, timezone spread | `docs/PUSH_DELIVERY.md` | `docs/NOTIFICATIONS.md`, `docs/RELEASE_DATES.md`; §12, §23 |
| Release dates, airing times, notification frequency | `docs/RELEASE_DATES.md` | — |
| Environment variables / feature degradation | `docs/ENVIRONMENT.md` | — |
| Full technical reference | `docs/DOCUMENTATION.md` (has a TOC; §-numbers above) | `docs/README.md` (doc map) |
| Project status / remaining work | `docs/To_DO.md` | `docs/ROADMAP.md` |
| Deploy, image builds, production updates | `production-docs/` (local, gitignored) | — |

## Release requirements (report; do not run unless delegated)
- API-affecting change → a new API image is required before the next production release
  (`docker build -t ghcr.io/metalingus/tvwatch-api:latest -f apps/api/Dockerfile .`). Pushing it
  is gate #1.
- Web-facing change in `apps/mobile` or a shared package the web app uses → a fresh Expo web export
  is required (`cd apps/mobile && npx expo export --platform web --output-dir ../app-web`).
- A local build/export is not a publication. Report build, export, push, and deploy separately.

## Final response checklist
Before finishing, review the full diff, then report concisely:
- **Validation:** which typecheck/lint/focused-test commands ran and their results; anything
  skipped and why. `git status --short` shows no stray emitted files.
- **API changes:** image build required / not required (not run unless delegated).
- **Web changes:** Expo web export required / not required.
- **Localization / theme:** keys added to all locales; tokens used; light and dark verified.
- **Data safety:** migration/backfill implications reviewed when models, imports, or repairs changed.
- **Remaining risks and release steps.** Never imply an unrun command completed.
